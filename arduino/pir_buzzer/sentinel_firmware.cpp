#include <Arduino.h>
#include <ArduinoJson.h>
#include <BLEDevice.h>
#include <BLE2902.h>
#include <atomic>
#include <esp_timer.h>
#include "driver/gpio.h"
#include "motion_alarm.h"
#include "line_framer.h"
#include "json_syntax.h"
#include "radar_config.h"
#include "storage_worker.h"
#include "buzzer_pattern.h"
#include "hardware_profile.h"

using namespace sentinel;
namespace {
constexpr uint8_t PirPin=hardware::PirPin, BuzzerPin=hardware::BuzzerPin;
constexpr uint8_t RadarRx=18, RadarTx=17; // Historical optional-radar code only.
constexpr char ServiceUuid[]="7b6a0001-6c2d-4b7e-9f10-15a2b3c4d5e6";
constexpr char RxUuid[]="7b6a0002-6c2d-4b7e-9f10-15a2b3c4d5e6";
constexpr char TxUuid[]="7b6a0003-6c2d-4b7e-9f10-15a2b3c4d5e6";
constexpr uint64_t MaxSafeInteger=9007199254740991ULL;
Config config;
MotionAlarm detector;
LogCache logs;
StorageWorker storage;
RadarParser radarParser;
RadarConfigEngine radarConfig;
RadarSample radarSample;
HardwareSerial radarUart(1);
uint32_t bootNumber=0, radarAt=0, loopMaxUs=0, storageErrors=0, actualHz=0;
uint64_t lastIssued=0, timeBaseEpoch=0, timeBaseUptime=0, radarUptime=0;
bool haveRadar=false, radarFresh=false, storageReady=false, timeKnown=false, outputReady=false, configInFlight=false;
bool pwmAttached=false, actualSound=false, usbSession=false, usbAttached=false;
char deviceId[13]{}, bootId[9]{}, deviceName[24]{};
std::atomic<bool> bleConnected{false}, notifyAccepted{false};
std::atomic<uint32_t> connectionEpoch{0}, rxGeneration{0}, callbackDrops{0};
uint32_t localEpoch=0, localRxGeneration=0, usbEpoch=0, queueDrops=0, txDrops=0;
BLECharacteristic* txCharacteristic=nullptr;
uint64_t uptime() { return static_cast<uint64_t>(esp_timer_get_time())/1000; }
uint64_t epoch() { return timeKnown?timeBaseEpoch+(uptime()-timeBaseUptime):0; }

struct Frame { char bytes[2048]{}; uint16_t length=0, offset=0; };
template<unsigned N> class FrameQueue {
 public:
  bool push(const Frame& frame) { if(count_==N) return false; frames_[(head_+count_)%N]=frame; ++count_; return true; }
  bool pop(Frame& frame) { if(!count_) return false; frame=frames_[head_]; head_=(head_+1)%N; --count_; return true; }
  unsigned count() const { return count_; }
  void clear() { count_=head_=0; }
 private: Frame frames_[N]{}; unsigned head_=0,count_=0;
};
class Link {
 public:
  bool reply(JsonDocument& doc) { Frame f; if(!encode(doc,f)) return false; if(!replies.push(f)) { ++txDrops; return false; } return true; }
  void event(JsonDocument& doc) { Frame f; if(encode(doc,f) && !events.push(f)) ++txDrops; }
  void state(JsonDocument& doc) { if(encode(doc,stateFrame)) hasState=true; }
  bool next() {
    if(current.offset<current.length) return true;
    current.length=current.offset=0;
    if(replies.pop(current) || events.pop(current)) return true;
    if(hasState) { current=stateFrame; hasState=false; return true; } return false;
  }
  void clear() { replies.clear(); events.clear(); hasState=false; current.length=current.offset=0; }
  Frame current{},stateFrame{}; FrameQueue<3> replies; FrameQueue<2> events; bool hasState=false;
 private:
  bool encode(JsonDocument& doc,Frame& f) {
    const size_t n=measureJson(doc); if(n+1>sizeof(f.bytes)) { ++txDrops; return false; }
    serializeJson(doc,f.bytes,n+1); f.bytes[n]='\n'; f.length=n+1; f.offset=0; return true;
  }
};
Link usbLink,bleLink;
uint32_t linkEpoch(const Link& link) { return &link==&bleLink?connectionEpoch.load():usbEpoch; }
LineFramer<> usbFramer,bleFramer;
struct BlePacket { uint32_t epoch=0,generation=0; uint8_t length=0,bytes[20]{}; };
QueueHandle_t bleRxQueue=nullptr;

bool online(uint32_t now) {
  if constexpr(!hardware::RadarSupported) return !configInFlight;
  return !configInFlight && (!config.radar || (radarConfig.ready && !radarConfig.busy && radarFresh && static_cast<uint32_t>(now-radarAt)<2000));
}
bool motion(uint32_t now) {
  if constexpr(!hardware::RadarSupported) return digitalRead(PirPin)==HIGH;
  return config.radar?(online(now) && radarSample.motion):(digitalRead(PirPin)==HIGH);
}
bool startRadarConfig(const Config& target,uint32_t now) {
  if constexpr(hardware::RadarSupported) return radarConfig.start(target,now);
  return false;
}
void output(bool on,uint32_t hz=0) {
  if(!hz) hz=config.toneHz;
  if(on==actualSound && (config.active || !on || actualHz==hz)) return;
  if(config.active) digitalWrite(BuzzerPin,on?!config.activeLow:config.activeLow);
  else if(pwmAttached) {
    if(on) { if(!ledcWriteTone(BuzzerPin,hz)) { ledcWrite(BuzzerPin,0); outputReady=false; on=false; } }
    else ledcWrite(BuzzerPin,0);
  } else on=false;
  actualSound=on; actualHz=on?hz:0;
}
void driveOutput() {
  if(!detector.sounding) { output(false); return; }
  const auto sample=sampleBuzzer(config.sound,config.toneHz,detector.soundingElapsed(millis()));
  output(sample.enabled,sample.hz);
}
bool configureOutput() {
  output(false);
  if(pwmAttached) { ledcDetach(BuzzerPin); pwmAttached=false; }
  const uint32_t inactive=config.active && config.activeLow?HIGH:LOW;
  // Preload the hardware latch while still high-Z, even after LEDC detached
  // and Arduino's pin bus manager has temporarily released this GPIO.
  gpio_set_level(static_cast<gpio_num_t>(BuzzerPin),inactive);
  pinMode(BuzzerPin,OUTPUT); digitalWrite(BuzzerPin,inactive);
  actualSound=false;
  if(config.active) return outputReady=true;
  pwmAttached=ledcAttach(BuzzerPin,config.toneHz,8);
  if(pwmAttached) ledcWrite(BuzzerPin,0);
  return outputReady=pwmAttached;
}
void stopNow() { detector.cancel(millis()); output(false); }
void logJson(JsonObject out,const LogRecord& r) {
  char boot[9]; snprintf(boot,sizeof(boot),"%08lX",static_cast<unsigned long>(r.bootId));
  out["seq"]=r.seq; out["bootId"]=boot; out["uptimeMs"]=r.uptimeMs; out["epochMs"]=r.epochMs;
  out["type"]=r.type?"test":"motion"; out["result"]=r.result==1?"muted":r.result==2?"disarmed":"sounded";
  out["distanceCm"]=r.distanceCm; out["energy"]=r.energy;
}
void stateJson(JsonObject out) {
  const uint32_t now=millis(); const bool fresh=online(now);
  out["motion"]=motion(now); out["present"]=config.radar?(fresh && radarSample.present):motion(now);
  out["sounding"]=detector.sounding; out["outputOn"]=actualSound; out["phase"]=detector.phase(now,fresh);
  out["uptimeMs"]=uptime(); out["triggerCount"]=detector.triggers; out["timeKnown"]=timeKnown;
  out["distanceCm"]=config.radar && fresh?radarSample.distanceCm:0;
  out["motionEnergy"]=config.radar && fresh?radarSample.motionEnergy:0;
  out["stillEnergy"]=config.radar && fresh?radarSample.stillEnergy:0;
  out["radarAgeMs"]=haveRadar?uptime()-radarUptime:UINT32_MAX;
  out["freeHeap"]=ESP.getFreeHeap(); out["minFreeHeap"]=ESP.getMinFreeHeap(); out["loopMaxUs"]=loopMaxUs;
  out["queueDrops"]=queueDrops+callbackDrops.load(); out["txDrops"]=txDrops;
  out["storageReady"]=storageReady; out["storageErrors"]=storageErrors; out["outputReady"]=outputReady;
  out["radarReady"]=radarConfig.ready; out["radarError"]=radarConfig.error;
  out["radarFrameErrors"]=radarParser.errors; out["settingsCorrupt"]=storage.settingsCorrupt;
  out["settingsMigrated"]=storage.settingsMigrated; out["profileSaveFailed"]=storage.profileSaveFailed;
}
void snapshot(JsonObject out) {
  out["deviceId"]=deviceId; out["version"]="1.0.2"; out["bootId"]=bootId;
  JsonObject profile=out["hardware"].to<JsonObject>(); profile["sensorModel"]=hardware::SensorModel;
  profile["pirPin"]=hardware::PirPin; profile["buzzerPin"]=hardware::BuzzerPin; profile["radarSupported"]=hardware::RadarSupported;
  configJson(out["config"].to<JsonObject>(),config); stateJson(out["state"].to<JsonObject>());
  JsonObject meta=out["logs"].to<JsonObject>(); meta["oldest"]=logs.oldest; meta["latest"]=logs.latest;
  meta["count"]=logs.count; meta["capacity"]=LogCapacity;
}
bool success(Link& link,uint64_t id,uint32_t ownerEpoch,const char* session=nullptr) {
  if(ownerEpoch!=linkEpoch(link)) return false;
  JsonDocument d; d["id"]=id; d["ok"]=true; if(session && *session) d["session"]=session;
  snapshot(d["data"].to<JsonObject>()); return link.reply(d);
}
void error(Link& link,uint64_t id,const char* code,const char* message,uint32_t ownerEpoch,const char* session=nullptr) {
  if(ownerEpoch!=linkEpoch(link)) return;
  JsonDocument d; d["id"]=id; d["ok"]=false; d["error"]=code; d["message"]=message;
  if(session && *session) d["session"]=session;
  link.reply(d);
}
void broadcastLog(const LogRecord& r) {
  JsonDocument d; d["event"]="log"; logJson(d["data"].to<JsonObject>(),r);
  if(usbSession) usbLink.event(d);
  if(bleConnected.load()) bleLink.event(d);
}
void recordEvent(bool test) {
  if(!storageReady || lastIssued>=MaxSafeInteger) { ++queueDrops; return; }
  StorageJob job{}; job.op=StorageOp::Append;
  auto& r=job.record; r.seq=lastIssued+1; r.bootId=bootNumber; r.uptimeMs=uptime(); r.epochMs=epoch(); r.type=test?1:0;
  r.result=test?0:!config.armed?2:config.muted?1:0;
  if(config.radar && online(millis())) { r.distanceCm=radarSample.distanceCm; r.energy=radarSample.motionEnergy; }
  seal(r);
  if(storage.enqueue(job)) lastIssued=r.seq; else ++queueDrops;
}

enum class PendingStage { None,Radar,Save,Clear,RollbackSave,RollbackRadar,Reply };
struct Pending {
  PendingStage stage=PendingStage::None; Link* link=nullptr; uint64_t id=0; uint32_t token=0,epoch=0;
  Config next{}; bool ok=false, radarChanged=false; const char* failure="";
  char session[17]{};
} pending;
uint32_t tokenCounter=0;
bool sameRadar(const Config& a,const Config& b) {
  return a.radar==b.radar && a.radarMaxGate==b.radarMaxGate && a.radarMotionThreshold==b.radarMotionThreshold && a.radarStillThreshold==b.radarStillThreshold;
}
void pendingReply(bool ok,const char* message="") { configInFlight=false; pending.ok=ok; pending.failure=message; pending.stage=PendingStage::Reply; }
bool queueSettings(const Config& c,PendingStage stage) {
  StorageJob job{}; job.op=StorageOp::Settings; job.token=pending.token; job.config=c;
  if(!storage.enqueue(job)) { ++queueDrops; return false; } pending.stage=stage; return true;
}
void commitConfig() {
  stopNow(); const bool changedSensor=config.radar!=pending.next.radar;
  const Config previous=config;
  config=pending.next; detector.configure(millis(),config);
  if(!configureOutput()) {
    config=previous; detector.configure(millis(),config); configureOutput();
    if(!queueSettings(config,PendingStage::RollbackSave)) {
      radarConfig.ready=false; pendingReply(false,"buzzer initialization failed; settings rollback queue full");
    }
    return;
  }
  storage.settingsCorrupt=false;
  storage.profileSaveFailed=false;
  if(changedSensor) haveRadar=radarFresh=false;
  pendingReply(true);
}
void handleStorage() {
  if(!storage.results) return;
  StorageResult r{};
  for(unsigned n=0;n<4 && xQueueReceive(storage.results,&r,0)==pdTRUE;++n) {
    if(!r.ok) { ++storageErrors; storageReady=false; }
    if(r.op==StorageOp::Append) {
      if(r.ok) { logs.insert(r.record); broadcastLog(r.record); }
      else ++queueDrops;
      continue;
    }
    if(pending.stage==PendingStage::None || r.token!=pending.token) continue;
    if(r.op==StorageOp::Clear) {
      if(r.ok) logs.clear(r.through);
      pendingReply(r.ok,r.ok?"":"persistent log clear failed");
    } else if(pending.stage==PendingStage::Save) {
      if(r.ok) commitConfig();
      else {
        // putString is atomic; readback failed may still mean the new value was
        // committed. Restore the old NVS blob before reporting transaction loss.
        if(!queueSettings(config,PendingStage::RollbackSave)) {
          radarConfig.ready=false; pendingReply(false,"settings persistence failed; rollback could not be queued");
        }
      }
    } else if(pending.stage==PendingStage::RollbackSave) {
      if(pending.radarChanged && config.radar && startRadarConfig(config,millis())) pending.stage=PendingStage::RollbackRadar;
      else { if(pending.radarChanged) radarConfig.ready=false; pendingReply(false,r.ok?"settings write failed; old settings restored":"settings write and rollback failed"); }
    }
  }
}
void handleRadar() {
  if constexpr(!hardware::RadarSupported) return;
  for(unsigned n=0;n<256 && radarUart.available();++n) {
    const auto kind=radarParser.feed(static_cast<uint8_t>(radarUart.read()));
    if(kind==RadarParser::Kind::Ack) radarConfig.ack(radarParser.body,radarParser.length);
    else if(kind==RadarParser::Kind::Data) {
      RadarSample sample;
      if(radarParser.sample(sample)) { radarSample=sample; radarAt=millis(); radarUptime=uptime(); haveRadar=radarFresh=true; }
      else ++radarParser.errors;
    }
  }
  if(radarFresh && static_cast<uint32_t>(millis()-radarAt)>=2000) radarFresh=false;
  radarConfig.tick(millis());
  uint8_t packet[32]; const size_t n=radarConfig.command(packet,millis());
  if(n) radarUart.write(packet,n);
  if(!radarConfig.complete) return;
  radarConfig.complete=false;
  if(!radarConfig.success) {
    // Leave the module's configuration mode even if failure preceded mutation.
    static const uint8_t exitPacket[]={0xFD,0xFC,0xFB,0xFA,2,0,0xFE,0,4,3,2,1}; radarUart.write(exitPacket,sizeof(exitPacket));
    radarConfig.ready=false;
  }
  if(pending.stage==PendingStage::Radar) {
    if(!radarConfig.success) pendingReply(false,radarConfig.error);
    else if(!queueSettings(pending.next,PendingStage::Save)) {
      radarConfig.ready=false;
      if(config.radar && startRadarConfig(config,millis())) pending.stage=PendingStage::RollbackRadar;
      else pendingReply(false,"storage queue full; radar disabled until settings reapplied");
    }
  } else if(pending.stage==PendingStage::RollbackRadar) {
    radarConfig.ready=false; // Require explicit retry after any failed transaction.
    pendingReply(false,radarConfig.success?"settings transaction failed; radar restored but disabled until retry":"settings transaction failed and radar rollback failed");
  }
}
void handlePendingReply() {
  if(pending.stage!=PendingStage::Reply) return;
  if(pending.epoch!=linkEpoch(*pending.link)) { pending.stage=PendingStage::None; return; }
  if(pending.link->replies.count()>=3) return;
  if(pending.ok) success(*pending.link,pending.id,pending.epoch,pending.session);
  else error(*pending.link,pending.id,"transaction_failed",pending.failure,pending.epoch,pending.session);
  pending.stage=PendingStage::None;
}
bool integer(JsonVariantConst value,uint64_t& result,bool positive=false) {
  if(value.is<bool>() || !value.is<uint64_t>()) return false;
  result=value.as<uint64_t>(); return result<=MaxSafeInteger && (!positive || result>0);
}
void handleCommand(Link& link,const char* text,size_t length,uint32_t ownerEpoch) {
  if(ownerEpoch!=linkEpoch(link)) return;
  if(!JsonSyntax::valid(text,length)) { ++queueDrops; return; }
  JsonDocument d;
  if(deserializeJson(d,text,length,DeserializationOption::NestingLimit(4)) || !d.is<JsonObject>()) { ++queueDrops; return; }
  uint64_t id=0;
  if(!integer(d["id"],id,true) || !d["op"].is<const char*>()) { ++queueDrops; return; }
  if(strlen(d["op"].as<const char*>())!=d["op"].as<JsonString>().size()) { ++queueDrops; return; }
  const char* session=nullptr;
  if(!d["session"].isNull()) {
    session=d["session"].is<const char*>()?d["session"].as<const char*>():nullptr;
    bool valid=session && strlen(session)==16 && d["session"].as<JsonString>().size()==16;
    for(unsigned i=0;valid && i<16;++i) valid=(session[i]>='0' && session[i]<='9') || (session[i]>='a' && session[i]<='f') || (session[i]>='A' && session[i]<='F');
    if(!valid) { error(link,id,"invalid_session","session must be sixteen hexadecimal characters",ownerEpoch); return; }
  }
  const char* op=d["op"];
  if(ownerEpoch!=linkEpoch(link)) return;
  // Stop always reaches the output, even if a flooding client exhausted reply
  // slots. Other mutations require response capacity before execution.
  if(!strcmp(op,"stop")) {
    stopNow(); if(link.replies.count()<3) success(link,id,ownerEpoch,session); else ++queueDrops; return;
  }
  Config candidate;
  if(!strcmp(op,"set")) {
    const char* problem="";
    if(!parseConfig(d["config"],config,candidate,problem)) {
      if(link.replies.count()<3) error(link,id,"invalid_config",problem,ownerEpoch,session); else ++queueDrops;
      return;
    }
    if(const char* code=hardware::configurationError(candidate)) {
      if(link.replies.count()<3) error(link,id,code,"HC-SR505 firmware supports PIR only",ownerEpoch,session);
      else ++queueDrops;
      return;
    }
    for(JsonPairConst pair:d["config"].as<JsonObjectConst>()) {
      if(const char* code=hardware::patchFieldError(pair.key().c_str())) {
        if(link.replies.count()<3) error(link,id,code,"HC-SR505 has no radar sensitivity or distance settings",ownerEpoch,session);
        else ++queueDrops;
        return;
      }
    }
    // Also honor a valid mute/disarm immediately when storage is unhealthy or
    // another transaction is busy. Its ERROR still means config was not saved.
    if(ownerEpoch!=linkEpoch(link)) return;
    stopNow();
  }
  const unsigned reserve=pending.link==&link && pending.stage!=PendingStage::None?1:0;
  if(link.replies.count()+reserve>=3) { ++queueDrops; return; }
  if(!strcmp(op,"get")) { success(link,id,ownerEpoch,session); return; }
  if(!strcmp(op,"time")) {
    uint64_t value;
    if(!integer(d["epochMs"],value,true)) { error(link,id,"invalid_time","epochMs must be a positive safe integer",ownerEpoch,session); return; }
    if(ownerEpoch!=linkEpoch(link)) return;
    timeBaseEpoch=value; timeBaseUptime=uptime(); timeKnown=true; success(link,id,ownerEpoch,session); return;
  }
  if(!strcmp(op,"logs")) {
    uint64_t after=0,limit=5;
    if((!d["after"].isNull() && !integer(d["after"],after)) ||
       (!d["limit"].isNull() && (!integer(d["limit"],limit,true) || limit>5))) {
      error(link,id,"invalid_page","after must be a safe nonnegative integer; limit is 1..5",ownerEpoch,session); return;
    }
    JsonDocument reply; reply["id"]=id; reply["ok"]=true; if(session) reply["session"]=session;
    JsonObject data=reply["data"].to<JsonObject>();
    JsonArray entries=data["entries"].to<JsonArray>(); uint64_t next=after;
    for(unsigned n=0;n<limit;++n) {
      const LogRecord* r=logs.nextAfter(next); if(!r) break;
      logJson(entries.add<JsonObject>(),*r); next=r->seq;
    }
    const bool more=logs.nextAfter(next)!=nullptr;
    data["oldest"]=logs.oldest; data["latest"]=logs.latest; data["count"]=logs.count; data["next"]=next; data["hasMore"]=more;
    data["reset"]=(after>logs.latest) || (after<logs.latest && (!logs.count || after+1<logs.oldest));
    if(ownerEpoch==linkEpoch(link)) link.reply(reply);
    return;
  }
  if(pending.stage!=PendingStage::None || radarConfig.busy) { error(link,id,"busy","configuration/storage transaction in progress",ownerEpoch,session); return; }
  if(ownerEpoch!=linkEpoch(link)) return;
  if(!strcmp(op,"test")) {
    if(!outputReady) { error(link,id,"output_unavailable","buzzer GPIO initialization failed",ownerEpoch,session); return; }
    if(!detector.test(millis())) { error(link,id,"busy","buzzer is already sounding",ownerEpoch,session); return; }
    driveOutput(); recordEvent(true); success(link,id,ownerEpoch,session); return;
  }
  if(!strcmp(op,"clear")) {
    if(!storageReady) { error(link,id,"storage_unavailable","persistent log store is unavailable",ownerEpoch,session); return; }
    pending={}; pending.link=&link; pending.id=id; pending.token=++tokenCounter; pending.epoch=ownerEpoch;
    if(session) memcpy(pending.session,session,17);
    StorageJob job{}; job.op=StorageOp::Clear; job.token=pending.token;
    if(storage.enqueue(job)) pending.stage=PendingStage::Clear;
    else { ++queueDrops; pendingReply(false,"storage queue full"); }
    return;
  }
  if(!strcmp(op,"set")) {
    if(!storageReady) { error(link,id,"storage_unavailable","settings cannot be persisted",ownerEpoch,session); return; }
    // Safety actions happen now, before asynchronous UART/NVS work.
    stopNow(); configInFlight=true; pending={}; pending.link=&link; pending.id=id; pending.token=++tokenCounter;
    pending.epoch=ownerEpoch; pending.next=candidate;
    if(session) memcpy(pending.session,session,17);
    pending.radarChanged=candidate.radar && (!sameRadar(candidate,config) || !radarConfig.ready);
    if(pending.radarChanged) {
      if(startRadarConfig(candidate,millis())) pending.stage=PendingStage::Radar;
      else pendingReply(false,"radar busy");
    } else if(!queueSettings(candidate,PendingStage::Save)) pendingReply(false,"storage queue full");
    return;
  }
  error(link,id,"unknown_operation","unsupported op",ownerEpoch,session);
}

class ServerCallbacks final:public BLEServerCallbacks {
  void onConnect(BLEServer*) override { connectionEpoch.fetch_add(1); bleConnected.store(true); }
  void onDisconnect(BLEServer*) override { bleConnected.store(false); connectionEpoch.fetch_add(1); }
};
class RxCallbacks final:public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* c) override {
    const String value=c->getValue();
    if(value.length()>20) { callbackDrops.fetch_add(1); rxGeneration.fetch_add(1); return; }
    BlePacket packet{}; packet.epoch=connectionEpoch.load(); packet.generation=rxGeneration.load(); packet.length=value.length();
    memcpy(packet.bytes,value.c_str(),packet.length);
    if(xQueueSend(bleRxQueue,&packet,0)!=pdTRUE) { callbackDrops.fetch_add(1); rxGeneration.fetch_add(1); }
  }
};
class TxCallbacks final:public BLECharacteristicCallbacks {
  void onStatus(BLECharacteristic*,Status status,uint32_t) override { notifyAccepted.store(status==Status::SUCCESS_NOTIFY); }
};
void startBle() {
  bleRxQueue=xQueueCreate(48,sizeof(BlePacket)); if(!bleRxQueue) { ++queueDrops; return; }
  if(!BLEDevice::init(deviceName)) return;
  auto* server=BLEDevice::createServer(); server->setCallbacks(new ServerCallbacks()); server->advertiseOnDisconnect(true);
  auto* service=server->createService(ServiceUuid);
  auto* rx=service->createCharacteristic(RxUuid,BLECharacteristic::PROPERTY_WRITE); rx->setCallbacks(new RxCallbacks());
  txCharacteristic=service->createCharacteristic(TxUuid,BLECharacteristic::PROPERTY_NOTIFY); txCharacteristic->setCallbacks(new TxCallbacks());
#if defined(CONFIG_BLUEDROID_ENABLED)
  txCharacteristic->addDescriptor(new BLE2902());
#endif
  service->start(); BLEAdvertisementData advertising,scan;
  advertising.setFlags(0x06); advertising.setCompleteServices(BLEUUID(ServiceUuid)); scan.setName(deviceName);
  auto* manager=BLEDevice::getAdvertising(); manager->setAdvertisementData(advertising); manager->setScanResponseData(scan); manager->start();
}
void syncBleSession() {
  const uint32_t observed=connectionEpoch.load();
  if(observed!=localEpoch) { localEpoch=observed; localRxGeneration=rxGeneration.load(); bleFramer.reset(); bleLink.clear(); }
}
void receive() {
  syncBleSession();
  BlePacket packet{};
  for(unsigned n=0;bleRxQueue && n<16 && xQueueReceive(bleRxQueue,&packet,0)==pdTRUE;++n) {
    syncBleSession();
    if(packet.epoch!=connectionEpoch.load() || packet.epoch!=localEpoch || !bleConnected.load()) continue;
    const uint32_t generation=rxGeneration.load();
    if(generation!=localRxGeneration) { localRxGeneration=generation; bleFramer.poison(); }
    if(packet.generation!=localRxGeneration) continue;
    for(unsigned i=0;i<packet.length;++i) {
      if(packet.epoch!=connectionEpoch.load() || !bleConnected.load()) { syncBleSession(); break; }
      const auto result=bleFramer.feed(packet.bytes[i]);
      if(result==LineFramer<>::Result::Complete) {
        if(packet.epoch==connectionEpoch.load() && bleConnected.load()) handleCommand(bleLink,bleFramer.data(),bleFramer.size(),packet.epoch);
        else syncBleSession();
        bleFramer.reset();
      }
      else if(result==LineFramer<>::Result::Oversize) ++queueDrops;
    }
  }
  const bool attached=static_cast<bool>(Serial);
  if(attached!=usbAttached) { usbAttached=attached; ++usbEpoch; usbFramer.reset(); usbLink.clear(); usbSession=false; }
  for(unsigned n=0;attached && n<256 && Serial.available();++n) {
    const auto result=usbFramer.feed(static_cast<uint8_t>(Serial.read()));
    if(result==LineFramer<>::Result::Complete) {
      usbSession=true; handleCommand(usbLink,usbFramer.data(),usbFramer.size(),usbEpoch); usbFramer.reset();
    } else if(result==LineFramer<>::Result::Oversize) ++queueDrops;
  }
}
void transmit(uint32_t now) {
  if(usbSession && static_cast<bool>(Serial) && usbLink.next()) {
    Frame& f=usbLink.current; const int available=Serial.availableForWrite();
    if(available>0) {
      const size_t n=min(static_cast<size_t>(available),min(static_cast<size_t>(f.length-f.offset),static_cast<size_t>(256)));
      f.offset+=Serial.write(reinterpret_cast<const uint8_t*>(f.bytes+f.offset),n);
    }
  }
  static uint32_t sentAt=0,failedAt=0,failureEpoch=UINT32_MAX; static bool failing=false;
  const uint32_t observed=connectionEpoch.load();
  if(observed!=failureEpoch) { failureEpoch=observed; failing=false; failedAt=sentAt=now; }
  if(!bleConnected.load() || connectionEpoch.load()!=localEpoch || !txCharacteristic || static_cast<uint32_t>(now-sentAt)<8) return;
  sentAt=now;
  // notify(), unlike indicate(), is nonblocking in the bundled ESP32 BLE stack.
  // Budget <=4 chunks/loop and <=80 bytes/8ms; stop immediately on congestion.
  // Link::next keeps an in-progress frame intact, then selects replies first.
  for(unsigned chunk=0;chunk<4 && bleLink.next();++chunk) {
    if(connectionEpoch.load()!=localEpoch || !bleConnected.load()) return;
    Frame& f=bleLink.current; const size_t n=min(static_cast<size_t>(20),static_cast<size_t>(f.length-f.offset));
    notifyAccepted.store(false); txCharacteristic->setValue(reinterpret_cast<const uint8_t*>(f.bytes+f.offset),n);
    if(connectionEpoch.load()!=localEpoch) return;
    txCharacteristic->notify();
    if(connectionEpoch.load()!=localEpoch) return;
    if(notifyAccepted.load()) { f.offset+=n; failing=false; }
    else {
      if(!failing) { failing=true; failedAt=now; }
      if(static_cast<uint32_t>(now-failedAt)>=2000) {
        // Never drop a started frame's tail and concatenate another frame.
        ++txDrops; if(auto* server=BLEDevice::getServer()) server->disconnect(server->getConnId());
        bleLink.clear(); failing=false;
      }
      break;
    }
  }
}
}

void setup() {
  pinMode(PirPin,INPUT_PULLDOWN); pinMode(BuzzerPin,INPUT);
  if(Serial.setRxBufferSize(4096)!=4096) ++queueDrops;
  Serial.begin(115200); Serial.setTxTimeoutMs(0);
  const uint64_t mac=ESP.getEfuseMac(); snprintf(deviceId,sizeof(deviceId),"%012llX",static_cast<unsigned long long>(mac & 0xFFFFFFFFFFFFULL));
  bootNumber=esp_random(); snprintf(bootId,sizeof(bootId),"%08lX",static_cast<unsigned long>(bootNumber));
  snprintf(deviceName,sizeof(deviceName),"S3-Sentinel-%s",deviceId+6);
  const bool settingsOk=storage.loadSettings(config);
  if(storage.profileSaveFailed) ++storageErrors;
  if(settingsOk) configureOutput(); // Apply saved inactive polarity before log scan.
  storageReady=storage.begin(config,logs); lastIssued=logs.latest;
  detector.begin(millis(),config);
  if constexpr(hardware::RadarSupported) {
    radarUart.setRxBufferSize(2048); radarUart.begin(256000,SERIAL_8N1,RadarRx,RadarTx);
    if(config.radar) startRadarConfig(config,millis());
  }
  startBle();
}
void loop() {
  static uint32_t lastLoop=micros(),stateAt=0;
  const uint32_t started=micros(); const uint32_t interval=started-lastLoop; lastLoop=started; if(interval>loopMaxUs) loopMaxUs=interval;
  if constexpr(hardware::RadarSupported) handleRadar();
  const uint32_t now=millis(); if(detector.tick(now,motion(now),online(now))) recordEvent(false);
  driveOutput(); receive(); handleStorage(); handlePendingReply(); driveOutput();
  if(static_cast<uint32_t>(now-stateAt)>=200) {
    stateAt=now; JsonDocument d; d["event"]="state"; stateJson(d["data"].to<JsonObject>());
    if(usbSession) usbLink.state(d);
    if(bleConnected.load()) bleLink.state(d);
  }
  transmit(millis());
  const uint32_t afterTx=millis();
  if(detector.tick(afterTx,motion(afterTx),online(afterTx))) recordEvent(false);
  driveOutput();
  const uint32_t work=micros()-started; if(work>loopMaxUs) loopMaxUs=work;
  // Yield one scheduler tick; all deadlines remain millis-driven and independent
  // of connected clients. No serial/radar/filesystem waits occur in this task.
  delay(1);
}
