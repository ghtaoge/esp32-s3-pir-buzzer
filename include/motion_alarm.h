#pragma once
#include <stdint.h>

namespace pir {
constexpr uint32_t BeepMs = 2000;
constexpr uint32_t HighStableMs = 30;
constexpr uint32_t LowStableMs = 100;

// All timers use unsigned elapsed time, including across millis() rollover.
class MotionAlarm {
 public:
  void tick(uint32_t now, bool inputHigh) {
    if (sounding && static_cast<uint32_t>(now - beepAt_) >= BeepMs) sounding = false;
    if (inputHigh) {
      lowTracking_ = false;
      if (!highTracking_) { highTracking_ = true; highAt_ = now; }
      if (armed && !sounding && static_cast<uint32_t>(now - highAt_) >= HighStableMs) {
        sounding = true;
        armed = false;
        beepAt_ = now;
        ++triggers;
      }
    } else {
      highTracking_ = false;
      if (!lowTracking_) { lowTracking_ = true; lowAt_ = now; }
      // A held HIGH cannot start a second beep; require a quiet interval first.
      if (!sounding && static_cast<uint32_t>(now - lowAt_) >= LowStableMs) armed = true;
    }
  }

  bool armed = true;
  bool sounding = false;
  uint32_t triggers = 0;

 private:
  uint32_t beepAt_ = 0;
  uint32_t highAt_ = 0;
  uint32_t lowAt_ = 0;
  bool highTracking_ = false;
  bool lowTracking_ = false;
};
}  // namespace pir
