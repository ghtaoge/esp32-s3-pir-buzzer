#pragma once
#include <Arduino.h>
#include <LittleFS.h>
#include <Preferences.h>
#include "config_json.h"
#include "log_store.h"
#include "hardware_profile.h"

namespace sentinel {
struct DiskHeader {
  uint32_t magic=0x534E5431, version=1;
  uint64_t generation=0, latest=0, clearedThrough=0;
  uint32_t crc=0, reserved=0;
};
static_assert(sizeof(DiskHeader)==40 && offsetof(DiskHeader,crc)==32,"persistent header layout changed");
inline void seal(DiskHeader& h) { h.crc=checksum(&h,offsetof(DiskHeader,crc)); }
inline bool valid(const DiskHeader& h) { return h.magic==0x534E5431 && h.version==1 && h.clearedThrough<=h.latest && h.crc==checksum(&h,offsetof(DiskHeader,crc)); }
enum class StorageOp:uint8_t { Append, Clear, Settings };
struct StorageJob { StorageOp op{}; uint32_t token=0; LogRecord record{}; Config config{}; };
struct StorageResult { StorageOp op{}; uint32_t token=0; bool ok=false; uint64_t through=0; LogRecord record{}; };

class StorageWorker {
 public:
  bool loadSettings(Config& config) {
    if(!prefsReady_) prefsReady_=prefs_.begin("s3-sentinel",false);
    if(!prefsReady_) return false;
    const String saved=prefs_.getString("config","");
    if(saved.length()) {
      JsonDocument d; const char* error=""; Config parsed{};
      if(!deserializeJson(d,saved) && parseConfig(d.as<JsonVariantConst>(),Config{},parsed,error)) config=parsed;
      else { settingsCorrupt=true; return false; }
      if(hardware::migrateStoredConfig(config)) {
        settingsMigrated=true;
        JsonDocument migrated; configJson(migrated.to<JsonObject>(),config);
        String text; serializeJson(migrated,text);
        profileSaveFailed=prefs_.putString("config",text)!=text.length();
        if(!profileSaveFailed) profileSaveFailed=prefs_.getString("config","")!=text;
        // Still use the explicit HC-SR505 profile this boot if NVS persistence
        // fails. Report the failure; do not activate UART or invent detection.
      }
    }
    return true;
  }
  bool begin(Config& config, LogCache& cache) {
    if(!prefsReady_ && !loadSettings(config)) return false;
    // A known filesystem is never auto-formatted on mount failure: that could
    // erase the sequence watermark. Fresh devices alone get one initialization.
    const bool initialized=prefs_.getBool("fs-ready",false);
    if(!LittleFS.begin(false)) {
      if(initialized || !LittleFS.format() || !LittleFS.begin(false)) return false;
    }
    const bool exists=LittleFS.exists("/events.bin");
    if(!exists && initialized) return false;
    file_=LittleFS.open("/events.bin",exists?"r+":"w+");
    if(!file_) return false;
    if(!exists) {
      uint8_t zeros[256]{}; size_t remaining=2*sizeof(DiskHeader)+LogCapacity*sizeof(LogRecord);
      while(remaining) { const size_t n=remaining<sizeof(zeros)?remaining:sizeof(zeros); if(file_.write(zeros,n)!=n) return false; remaining-=n; }
      header_.generation=1; seal(header_);
      if(!writeAt(0,&header_,sizeof(header_))) return false;
      file_.flush();
      if(!prefs_.putBool("fs-ready",true)) return false;
    }
    DiskHeader a{},b{};
    if(!readAt(0,&a,sizeof(a)) || !readAt(sizeof(a),&b,sizeof(b))) return false;
    if(!valid(a) && !valid(b)) return false;
    header_=valid(b) && (!valid(a) || b.generation>a.generation)?b:a;
    cache.latest=header_.latest; cache.clearedThrough=header_.clearedThrough;
    // A valid record committed before a power loss can be newer than a header.
    for(unsigned i=0;i<LogCapacity;++i) {
      LogRecord r{};
      if(!readAt(2*sizeof(DiskHeader)+i*sizeof(LogRecord),&r,sizeof(r))) return false;
      if(valid(r) && r.seq%LogCapacity==i) { cache.insert(r,false); if(r.seq>header_.latest) header_.latest=r.seq; }
    }
    cache.refresh();
    if(!initialized && !prefs_.putBool("fs-ready",true)) return false;
    jobs=xQueueCreate(16,sizeof(StorageJob)); results=xQueueCreate(16,sizeof(StorageResult));
    if(!jobs || !results) return false;
    return xTaskCreatePinnedToCore(task,"sentinel-storage",6144,this,1,nullptr,0)==pdPASS;
  }
  bool enqueue(const StorageJob& job) { return jobs && xQueueSend(jobs,&job,0)==pdTRUE; }
  QueueHandle_t jobs=nullptr, results=nullptr;
  bool settingsCorrupt=false, settingsMigrated=false, profileSaveFailed=false;
 private:
  static void task(void* ptr) { static_cast<StorageWorker*>(ptr)->run(); }
  void run() {
    StorageJob job;
    for(;;) {
      if(xQueueReceive(jobs,&job,portMAX_DELAY)!=pdTRUE) continue;
      StorageResult reply{}; reply.op=job.op; reply.token=job.token; reply.record=job.record;
      if(job.op==StorageOp::Settings) {
        JsonDocument doc; configJson(doc.to<JsonObject>(),job.config); String text; serializeJson(doc,text);
        reply.ok=prefs_.putString("config",text)==text.length();
        if(reply.ok) { const String saved=prefs_.getString("config",""); reply.ok=saved==text; }
      } else if(job.op==StorageOp::Append) {
        reply.ok=valid(job.record) && job.record.seq>header_.latest &&
          writeAt(2*sizeof(DiskHeader)+(job.record.seq%LogCapacity)*sizeof(LogRecord),&job.record,sizeof(job.record));
        if(reply.ok) { file_.flush(); DiskHeader next=header_; next.latest=job.record.seq; reply.ok=saveHeader(next); }
      } else {
        DiskHeader next=header_; next.clearedThrough=next.latest;
        reply.ok=saveHeader(next); reply.through=header_.clearedThrough;
      }
      // A full response queue never blocks the detector. Only the worker waits.
      xQueueSend(results,&reply,portMAX_DELAY);
    }
  }
  bool saveHeader(DiskHeader next) {
    next.generation=header_.generation+1; seal(next);
    const size_t offset=(next.generation&1)?0:sizeof(DiskHeader);
    if(!writeAt(offset,&next,sizeof(next))) return false;
    file_.flush(); DiskHeader check{};
    if(!readAt(offset,&check,sizeof(check)) || !valid(check) || memcmp(&next,&check,sizeof(next))) return false;
    header_=next; return true;
  }
  bool readAt(size_t offset,void* out,size_t n) { return file_.seek(offset) && file_.read(static_cast<uint8_t*>(out),n)==n; }
  bool writeAt(size_t offset,const void* in,size_t n) { return file_.seek(offset) && file_.write(static_cast<const uint8_t*>(in),n)==n; }
  Preferences prefs_; File file_; DiskHeader header_{}; bool prefsReady_=false;
};
}
