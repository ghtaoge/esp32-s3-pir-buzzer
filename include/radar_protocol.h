#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace sentinel {
inline uint16_t le16(const uint8_t* p) { return static_cast<uint16_t>(p[0]) | (static_cast<uint16_t>(p[1]) << 8); }
inline void put16(uint8_t* p, uint16_t n) { p[0] = n; p[1] = n >> 8; }
inline void put32(uint8_t* p, uint32_t n) { for (unsigned i=0;i<4;++i) p[i] = n >> (8*i); }
struct RadarSample { bool motion = false, present = false; uint16_t distanceCm = 0; uint8_t motionEnergy = 0, stillEnergy = 0; };

class RadarParser {
 public:
  enum class Kind { None, Data, Ack };
  Kind feed(uint8_t value) {
    if (used_ == sizeof(buffer_)) shift();
    buffer_[used_++] = value;
    while (used_ >= 4) {
      const bool data = !memcmp(buffer_, "\xF4\xF3\xF2\xF1", 4);
      const bool ack = !memcmp(buffer_, "\xFD\xFC\xFB\xFA", 4);
      if (!data && !ack) { shift(); continue; }
      if (used_ < 6) return Kind::None;
      const size_t payload = le16(buffer_ + 4);
      if (payload < (data ? 13u : 4u) || payload > 128) { ++errors; shift(); continue; }
      const size_t total = payload + 10;
      if (used_ < total) return Kind::None;
      const char* tail = data ? "\xF8\xF7\xF6\xF5" : "\x04\x03\x02\x01";
      if (memcmp(buffer_ + 6 + payload, tail, 4)) { ++errors; shift(); continue; }
      memcpy(body, buffer_ + 6, payload); length = payload;
      used_ -= total; memmove(buffer_, buffer_ + total, used_);
      return data ? Kind::Data : Kind::Ack;
    }
    return Kind::None;
  }
  bool sample(RadarSample& out) const {
    if (length < 13 || (body[0] != 1 && body[0] != 2) || body[1] != 0xAA ||
        body[length-2] != 0x55 || body[length-1] != 0 || body[2] > 3 || body[5]>100 || body[8]>100) return false;
    out.motion = (body[2] & 1) != 0; out.present = body[2] != 0;
    out.motionEnergy = body[5]; out.stillEnergy = body[8];
    out.distanceCm = out.motion ? le16(body + 3) : le16(body + 6);
    return true;
  }
  uint8_t body[128]{}; size_t length = 0; uint32_t errors = 0;
 private:
  void shift() { if (used_) { --used_; memmove(buffer_, buffer_ + 1, used_); } }
  uint8_t buffer_[138]{}; size_t used_ = 0;
};
}
