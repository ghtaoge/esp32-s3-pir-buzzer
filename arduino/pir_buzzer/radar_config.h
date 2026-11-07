#pragma once
#include "motion_alarm.h"
#include "radar_protocol.h"

namespace sentinel {
struct RadarParameters {
  uint8_t maxGate = 0, movingMax = 0, stillMax = 0;
  uint8_t moving[9]{}, still[9]{};
  uint16_t absentSeconds = 0;
};
inline bool readParameters(const uint8_t* p, size_t length, RadarParameters& out) {
  if (length < 16 || p[4] != 0xAA || p[5] < 2 || p[5] > 8) return false;
  const uint8_t n = p[5];
  if (length != static_cast<size_t>(10 + 2 * (n + 1)) || p[6] > n || p[7] > n) return false;
  out.maxGate = n; out.movingMax = p[6]; out.stillMax = p[7];
  for (unsigned i=0;i<=n;++i) {
    out.moving[i] = p[8+i]; out.still[i] = p[9+n+i];
    if (out.moving[i] > 100 || out.still[i] > 100) return false;
  }
  out.absentSeconds = le16(p + 10 + 2*n); return true;
}

// One command in flight. Caller pumps UART and checks timeout without waiting.
// Resolution is queried, never changed (changing it requires a radar reboot).
class RadarConfigEngine {
 public:
  bool start(const Config& target, uint32_t now) {
    if (busy) return false;
    target_ = target; priorReady_ = ready; ready = false;
    havePrior_ = wrote_ = restoring_ = false; complete = false; error = "";
    busy = true; stage_ = 0; queued_ = true; waiting_ = false; sentAt_ = now;
    return true;
  }
  // Full UART packet, at most 32 bytes. Returns zero if awaiting a reply.
  size_t command(uint8_t* out, uint32_t now) {
    if (!busy || !queued_) return 0;
    uint8_t payload[20]{}; size_t n = 0;
    if (!restoring_) {
      switch (stage_) {
        case 0: expected_ = 0xFF; put16(payload,1); n=2; break;
        case 1: expected_ = 0xAB; break;
        case 2: case 5: expected_ = 0x61; break;
        case 3: expected_ = 0x60; n = range(payload,target_.radarMaxGate,target_.radarMaxGate,prior_.absentSeconds); wrote_=true; break;
        case 4: expected_ = 0x64; n = sensitivity(payload,0xFFFF,target_.radarMotionThreshold,target_.radarStillThreshold); break;
        default: expected_ = 0xFE; break;
      }
    } else {
      if (stage_ == 0) { expected_ = 0xFF; put16(payload,1); n=2; }
      else if (stage_ == 1) { expected_ = 0x60; n=range(payload,prior_.movingMax,prior_.stillMax,prior_.absentSeconds); }
      else if (stage_ <= static_cast<unsigned>(prior_.maxGate + 2)) {
        expected_ = 0x64; const unsigned gate=stage_-2;
        n=sensitivity(payload,gate,prior_.moving[gate],prior_.still[gate]);
      } else if (stage_ == static_cast<unsigned>(prior_.maxGate + 3)) expected_=0x61;
      else expected_=0xFE;
    }
    memcpy(out,"\xFD\xFC\xFB\xFA",4); put16(out+4,n+2); put16(out+6,expected_);
    memcpy(out+8,payload,n); memcpy(out+8+n,"\x04\x03\x02\x01",4);
    queued_=false; waiting_=true; sentAt_=now; return n+12;
  }
  void tick(uint32_t now) { if (busy && waiting_ && static_cast<uint32_t>(now-sentAt_) >= 700) fail("radar_timeout"); }
  void ack(const uint8_t* p, size_t n) {
    if (!busy || !waiting_ || n<4 || le16(p) != static_cast<uint16_t>(expected_|0x100)) return;
    waiting_=false;
    if (le16(p+2)) { fail("radar_rejected"); return; }
    if (!restoring_) {
      if (stage_==1 && (n!=6 || le16(p+4)!=0)) { fail("radar_requires_075m_resolution"); return; }
      if (stage_==2) {
        if (!readParameters(p,n,prior_) || target_.radarMaxGate > prior_.maxGate) { fail("radar_unsupported_parameters"); return; }
        havePrior_=true;
      }
      if (stage_==5) {
        RadarParameters got{};
        if (!readParameters(p,n,got) || got.maxGate != prior_.maxGate ||
            got.movingMax != target_.radarMaxGate || got.stillMax != target_.radarMaxGate || got.absentSeconds != prior_.absentSeconds) {
          fail("radar_readback_mismatch"); return;
        }
        for (unsigned i=0;i<=got.maxGate;++i) if (got.moving[i]!=target_.radarMotionThreshold || got.still[i]!=target_.radarStillThreshold) {
          fail("radar_readback_mismatch"); return;
        }
      }
      if (stage_==6) { ready=true; finish(true); return; }
    } else {
      if (stage_==static_cast<unsigned>(prior_.maxGate+3)) {
        RadarParameters got{};
        if (!readParameters(p,n,got) || got.maxGate!=prior_.maxGate || got.movingMax!=prior_.movingMax ||
            got.stillMax!=prior_.stillMax || got.absentSeconds!=prior_.absentSeconds ||
            memcmp(got.moving,prior_.moving,prior_.maxGate+1) || memcmp(got.still,prior_.still,prior_.maxGate+1)) {
          fail("radar_rollback_failed"); return;
        }
      }
      if (stage_==static_cast<unsigned>(prior_.maxGate+4)) { ready=priorReady_; finish(false); return; }
    }
    ++stage_; queued_=true;
  }
  bool busy=false, ready=false, complete=false, success=false;
  const char* error="";
 private:
  static size_t range(uint8_t* p,uint8_t moving,uint8_t still,uint16_t absent) {
    put16(p,0); put32(p+2,moving); put16(p+6,1); put32(p+8,still); put16(p+12,2); put32(p+14,absent); return 18;
  }
  static size_t sensitivity(uint8_t* p,uint32_t gate,uint8_t moving,uint8_t still) {
    put16(p,0); put32(p+2,gate); put16(p+6,1); put32(p+8,moving); put16(p+12,2); put32(p+14,still); return 18;
  }
  void finish(bool ok) { busy=false; complete=true; success=ok; waiting_=queued_=false; }
  void fail(const char* reason) {
    waiting_=false;
    if (restoring_) { error="radar_rollback_failed"; ready=false; finish(false); return; }
    error=reason;
    if (wrote_ && havePrior_) { restoring_=true; stage_=0; queued_=true; return; }
    // No settings were written. Exit configuration mode best-effort is performed
    // by the caller; keep the detector offline until an acknowledged setup.
    ready=false; finish(false);
  }
  Config target_{}; RadarParameters prior_{};
  unsigned stage_=0; uint16_t expected_=0; uint32_t sentAt_=0;
  bool queued_=false, waiting_=false, restoring_=false, havePrior_=false, wrote_=false, priorReady_=false;
};
}
