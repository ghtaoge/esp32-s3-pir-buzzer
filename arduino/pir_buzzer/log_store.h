#pragma once
#include <stdint.h>
#include <stddef.h>
#include <string.h>

namespace sentinel {
constexpr unsigned LogCapacity=1000;
struct LogRecord {
  uint64_t seq=0, epochMs=0, uptimeMs=0;
  uint32_t bootId=0;
  uint16_t distanceCm=0;
  uint8_t type=0, result=0, energy=0, reserved[3]{};
  uint32_t crc=0;
};
static_assert(sizeof(LogRecord)==40 && offsetof(LogRecord,crc)==36,"persistent record layout changed; migrate version first");
inline uint32_t checksum(const void* ptr,size_t length) {
  const auto* p=static_cast<const uint8_t*>(ptr); uint32_t crc=0xFFFFFFFF;
  while (length--) { crc^=*p++; for(unsigned i=0;i<8;++i) crc=(crc>>1)^(0xEDB88320u & (0u-(crc&1u))); }
  return ~crc;
}
inline void seal(LogRecord& r) { r.crc=checksum(&r,offsetof(LogRecord,crc)); }
inline bool valid(const LogRecord& r) { return r.seq && r.type<=1 && r.result<=3 && r.crc==checksum(&r,offsetof(LogRecord,crc)); }

// RAM mirror belongs to the detector task. Disk worker never touches this cache.
class LogCache {
 public:
  void insert(const LogRecord& r, bool recount=true) { if(!valid(r)) return; records_[r.seq%LogCapacity]=r; if(r.seq>latest) latest=r.seq; if(recount) refresh(); }
  void clear(uint64_t through) { if(through>clearedThrough) clearedThrough=through; if(through>latest) latest=through; refresh(); }
  const LogRecord* find(uint64_t seq) const {
    const LogRecord& r=records_[seq%LogCapacity];
    return seq>clearedThrough && r.seq==seq ? &r : nullptr;
  }
  const LogRecord* nextAfter(uint64_t after) const {
    const LogRecord* next=nullptr;
    for(const auto& r:records_) if(r.seq>clearedThrough && r.seq>after && (!next || r.seq<next->seq)) next=&r;
    return next;
  }
  void refresh() {
    count=0; oldest=0;
    for (const auto& r:records_) if (r.seq>clearedThrough) {
      ++count; if(!oldest || r.seq<oldest) oldest=r.seq;
    }
  }
  uint64_t latest=0, oldest=0, clearedThrough=0;
  unsigned count=0;
 private:
  LogRecord records_[LogCapacity]{};
};
}
