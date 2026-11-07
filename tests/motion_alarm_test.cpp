#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "motion_alarm.h"
using namespace sentinel;
static Config fast() { Config c; c.warmupMs=0; c.cooldownMs=100; c.releaseMs=100; c.confirmMs=30; c.beepMs=2000; return c; }
int main() {
  {
    MotionAlarm d; Config c=fast(); d.begin(0,c);
    assert(!d.tick(0,true)); assert(!d.tick(10000,true)); assert(!d.sounding); // startup HIGH never counts as release
    d.tick(10010,false); d.tick(10109,false); assert(strcmp(d.phase(10109,true),"ready"));
    d.tick(10110,false); assert(!strcmp(d.phase(10110,true),"ready"));
    assert(!d.tick(10120,true)); assert(!d.tick(10149,true)); assert(d.tick(10150,true));
    assert(d.sounding && d.triggers==1); d.tick(12149,true); assert(d.sounding);
    d.tick(12150,true); assert(!d.sounding); d.tick(60000,true); assert(!d.sounding && d.triggers==1);
    d.tick(60010,false); d.tick(60109,false); d.tick(60110,true); d.tick(60200,true); assert(d.triggers==1);
    d.tick(60300,false); d.tick(60400,false); assert(!d.tick(60410,true)); assert(d.tick(60440,true)); assert(d.triggers==2);
  }
  {
    // Release during sound is merged; it cannot queue a second event.
    MotionAlarm d; Config c=fast(); d.begin(0,c); d.tick(0,false); d.tick(100,false); d.tick(101,true); d.tick(131,true);
    d.tick(500,false); d.tick(1000,false); d.tick(1500,true); d.tick(2131,true); assert(!d.sounding && d.triggers==1);
    d.tick(10000,true); assert(d.triggers==1);
  }
  {
    Config c=fast(); c.muted=true; MotionAlarm d; d.begin(0,c); d.tick(0,false); d.tick(100,false); d.tick(110,true);
    assert(d.tick(140,true)); assert(!d.sounding && d.triggers==1); assert(!d.tick(50000,true));
    assert(d.test(50001)); assert(d.sounding && d.triggers==1); assert(!d.test(50002));
    d.tick(52001,true); assert(!d.sounding && d.triggers==1);
    c.muted=false; c.armed=false; d.configure(53000,c); d.tick(53000,false); d.tick(53100,false); d.tick(53110,true);
    assert(d.tick(53140,true) && d.triggers==2 && !d.sounding);
  }
  {
    Config c=fast(); MotionAlarm d; d.begin(0,c); assert(d.test(0)); d.cancel(10); assert(!d.sounding);
    d.tick(10000,true); assert(!d.sounding && !d.triggers);
    d.tick(10001,false); d.tick(10101,false); d.tick(10102,true); assert(d.tick(10132,true));
    c.muted=true; d.configure(10133,c); assert(!d.sounding);
  }
  {
    // Confirmation, sound cutoff and quiet/cooldown boundaries at uint32 wrap.
    MotionAlarm d; Config c=fast(); const uint32_t start=UINT32_MAX-200; d.begin(start,c);
    d.tick(start,false); d.tick(start+100,false); d.tick(UINT32_MAX-10,true);
    assert(!d.tick(18,true)); assert(d.tick(19,true)); d.tick(2018,true); assert(d.sounding); d.tick(2019,true); assert(!d.sounding);
    d.tick(2020,false); d.tick(2119,false); assert(strcmp(d.phase(2119,true),"ready")); d.tick(2120,false); assert(!strcmp(d.phase(2120,true),"ready"));
  }
  {
    Config c=fast(); c.warmupMs=1000; MotionAlarm d; d.begin(0,c);
    d.tick(0,false); d.tick(999,false); assert(!strcmp(d.phase(999,true),"warmup"));
    d.tick(1000,false); d.tick(1100,false); assert(!strcmp(d.phase(1100,true),"ready"));
    // Warmup never recurs after millis completes an entire cycle.
    d.tick(10,false); assert(strcmp(d.phase(10,true),"warmup"));
  }
  {
    Config c=fast(); c.radar=true; MotionAlarm d; d.begin(0,c);
    d.tick(0,false,false); d.tick(500,false,false); assert(!strcmp(d.phase(500,false),"sensor_offline"));
    d.tick(600,true,true); d.tick(900,true,true); assert(!d.triggers);
    d.tick(1000,false,true); d.tick(1100,false,true); d.tick(1110,true,true); assert(d.tick(1140,true,true));
    d.tick(1141,true,false); assert(!d.sounding); assert(!strcmp(d.phase(1141,false),"sensor_offline"));
    assert(d.test(2000)); d.tick(2001,false,false); assert(d.sounding); // explicit test bypasses sensor offline
  }
  puts("PASS detector: fixed cutoff, held motion, release/confirm, warmup, mute/disarm, manual stop/test, sensor offline, rollover");
}
