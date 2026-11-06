#include <assert.h>
#include <stdio.h>
#include "motion_alarm.h"

int main() {
  // Detect immediately after startup; a held HIGH must stop after 2 seconds.
  {
    pir::MotionAlarm unit;
    unit.tick(0, true);
    unit.tick(29, true);
    assert(!unit.sounding);
    unit.tick(30, true);
    assert(unit.sounding && unit.triggers == 1 && !unit.armed);
    unit.tick(2029, true);
    assert(unit.sounding);
    unit.tick(2030, true);
    assert(!unit.sounding);
    unit.tick(60000, true);
    assert(!unit.sounding && unit.triggers == 1);

    // A brief LOW cannot rearm; a full quiet interval permits the next beep.
    unit.tick(60010, false);
    unit.tick(60108, false);
    assert(!unit.armed);
    unit.tick(60109, true);  // LOW lasted only 99 ms.
    unit.tick(60139, true);
    assert(!unit.armed && !unit.sounding && unit.triggers == 1);
    unit.tick(60200, false);
    unit.tick(60299, false);
    assert(!unit.armed);
    unit.tick(60300, false);
    assert(unit.armed);
    unit.tick(60310, true);
    unit.tick(60339, true);
    assert(!unit.sounding && unit.triggers == 1);
    unit.tick(60340, true);
    assert(unit.sounding && unit.triggers == 2);
  }
  // Brief input noise is rejected, without delaying startup by a minute.
  {
    pir::MotionAlarm unit;
    unit.tick(0, false);
    unit.tick(10, true);
    unit.tick(38, true);
    unit.tick(39, false);  // HIGH lasted only 29 ms.
    assert(unit.armed && !unit.sounding && unit.triggers == 0);
    unit.tick(50, true);
    unit.tick(79, true);
    assert(!unit.sounding);
    unit.tick(80, true);
    assert(unit.sounding && unit.triggers == 1);
    unit.tick(2080, false);
    assert(!unit.sounding);
  }
  // The finite beep also stops when millis() wraps.
  {
    pir::MotionAlarm unit;
    unit.tick(UINT32_MAX - 100, true);
    unit.tick(UINT32_MAX - 71, true);
    assert(!unit.sounding);
    unit.tick(UINT32_MAX - 70, true);
    assert(unit.sounding);
    unit.tick(1928, true);
    assert(unit.sounding);
    unit.tick(1929, true);
    assert(!unit.sounding && !unit.armed);
  }
  // HIGH qualification and LOW rearming retain their exact boundaries at wrap.
  {
    pir::MotionAlarm unit;
    unit.tick(UINT32_MAX - 10, true);
    unit.tick(18, true);
    assert(!unit.sounding);
    unit.tick(19, true);
    assert(unit.sounding && unit.triggers == 1);
  }
  {
    pir::MotionAlarm unit;
    unit.tick(UINT32_MAX - 2400, true);
    unit.tick(UINT32_MAX - 2370, true);
    assert(unit.sounding);
    unit.tick(UINT32_MAX - 370, true);
    assert(!unit.sounding && !unit.armed);
    unit.tick(UINT32_MAX - 50, false);
    unit.tick(48, false);
    assert(!unit.armed);
    unit.tick(49, false);
    assert(unit.armed);
    unit.tick(60, true);
    unit.tick(90, true);
    assert(unit.sounding && unit.triggers == 2);
  }
  puts("PASS: 30ms HIGH/100ms LOW boundaries, 2-second cutoff, held-HIGH suppression, rearming, timer wrap");
}
