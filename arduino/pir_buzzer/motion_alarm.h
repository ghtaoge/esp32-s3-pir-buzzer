#pragma once
#include <stdint.h>

namespace sentinel {
enum class Sound:uint8_t { Single, Double, Chime, Siren };
struct Config {
  Sound sound=Sound::Single;
  bool radar = false, armed = true, muted = false, active = false, activeLow = false;
  uint32_t beepMs = 3000, cooldownMs = 1000, confirmMs = 200, releaseMs = 500;
  uint32_t warmupMs = 30000, toneHz = 2000;
  uint8_t radarMaxGate = 4, radarMotionThreshold = 35, radarStillThreshold = 45;
};

// Pure, rollover-safe detector. Presence is deliberately NOT an input here.
// A release must occur after sound stops; held activity can never retrigger.
class MotionAlarm {
 public:
  void begin(uint32_t now, const Config& config) { bootAt_ = now; warmupDone_ = false; config_ = config; cancel(now); }
  void configure(uint32_t now, const Config& config) { config_ = config; cancel(now); }
  void cancel(uint32_t now) {
    sounding = false; manual_ = false; ready_ = false;
    highTracking_ = lowTracking_ = false; cooldownAt_ = now; cooldown_ = true;
  }
  bool test(uint32_t now) {
    if (sounding) return false;
    sounding = true; manual_ = true; beepAt_ = now; beepDuration_ = config_.beepMs;
    ready_ = false; highTracking_ = lowTracking_ = false;
    return true;
  }
  bool tick(uint32_t now, bool motion, bool online = true) {
    if (!warming(now)) warmupDone_ = true;
    if (sounding && static_cast<uint32_t>(now - beepAt_) >= beepDuration_) {
      sounding = false; manual_ = false; cooldown_ = true; cooldownAt_ = now;
      lowTracking_ = highTracking_ = false;
    }
    if (!online || warming(now)) {
      ready_ = false; highTracking_ = lowTracking_ = false;
      if (sounding && !manual_) cancel(now);
      return false;
    }
    if (sounding) return false;
    if (cooldown_ && static_cast<uint32_t>(now - cooldownAt_) >= config_.cooldownMs) cooldown_ = false;
    if (!motion) {
      highTracking_ = false;
      if (!lowTracking_) { lowTracking_ = true; lowAt_ = now; }
      if (!cooldown_ && static_cast<uint32_t>(now - lowAt_) >= config_.releaseMs) ready_ = true;
      return false;
    }
    lowTracking_ = false;
    if (!ready_) { highTracking_ = false; return false; }
    if (!highTracking_) { highTracking_ = true; highAt_ = now; }
    if (static_cast<uint32_t>(now - highAt_) < config_.confirmMs) return false;
    ++triggers; ready_ = false; highTracking_ = false;
    cooldown_ = true; cooldownAt_ = now;
    if (config_.armed && !config_.muted) {
      sounding = true; manual_ = false; beepAt_ = now; beepDuration_ = config_.beepMs;
    }
    return true;
  }
  const char* phase(uint32_t now, bool online) const {
    if (sounding) return "sounding";
    if (!online) return "sensor_offline";
    if (warming(now)) return "warmup";
    if (ready_) return "ready";
    if (cooldown_) return "cooldown";
    return "waiting_release";
  }
  bool warming(uint32_t now) const { return !warmupDone_ && !config_.radar && static_cast<uint32_t>(now - bootAt_) < config_.warmupMs; }
  uint32_t soundingElapsed(uint32_t now) const { return sounding?static_cast<uint32_t>(now-beepAt_):0; }
  bool sounding = false;
  uint32_t triggers = 0;
 private:
  Config config_{};
  bool ready_ = false, manual_ = false, cooldown_ = true, warmupDone_ = false;
  bool highTracking_ = false, lowTracking_ = false;
  uint32_t bootAt_ = 0, highAt_ = 0, lowAt_ = 0, beepAt_ = 0, beepDuration_ = 0, cooldownAt_ = 0;
};
}
