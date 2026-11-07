#include <assert.h>
#include <stdio.h>
#include "buzzer_pattern.h"
using namespace sentinel;
int main() {
  assert(sampleBuzzer(Sound::Single,2000,0).enabled && sampleBuzzer(Sound::Single,2000,9999).hz==2000);
  assert(sampleBuzzer(Sound::Double,2000,119).enabled);
  assert(!sampleBuzzer(Sound::Double,2000,120).enabled && !sampleBuzzer(Sound::Double,2000,219).enabled);
  assert(sampleBuzzer(Sound::Double,2000,220).enabled && sampleBuzzer(Sound::Double,2000,339).enabled);
  assert(!sampleBuzzer(Sound::Double,2000,340).enabled && !sampleBuzzer(Sound::Double,2000,799).enabled);
  assert(sampleBuzzer(Sound::Double,2000,800).enabled);
  assert(sampleBuzzer(Sound::Chime,2000,199).hz==2000 && sampleBuzzer(Sound::Chime,2000,200).hz==1600);
  assert(sampleBuzzer(Sound::Chime,2000,399).enabled && !sampleBuzzer(Sound::Chime,2000,400).enabled);
  assert(sampleBuzzer(Sound::Siren,2000,149).hz==1500 && sampleBuzzer(Sound::Siren,2000,150).hz==2500);
  assert(sampleBuzzer(Sound::Siren,2000,300).hz==1500);
  assert(sampleBuzzer(Sound::Siren,200,0).hz==200 && sampleBuzzer(Sound::Siren,5000,150).hz==5000);
  const Sound sounds[]={Sound::Single,Sound::Double,Sound::Chime,Sound::Siren};
  for(Sound sound:sounds) {
    Config c; c.sound=sound; c.warmupMs=0; c.beepMs=1000; MotionAlarm alarm; alarm.begin(UINT32_MAX-400,c);
    assert(alarm.test(UINT32_MAX-100));
    alarm.tick(398,false); assert(alarm.sounding && alarm.soundingElapsed(398)==499);
    alarm.tick(898,false); assert(alarm.sounding); alarm.tick(899,false); assert(!alarm.sounding && !alarm.triggers);
    assert(alarm.test(1000)); alarm.cancel(1001); assert(!alarm.sounding);
  }
  puts("PASS sound patterns: exact rhythm boundaries, pitch/clamping, fixed window/cancel/rollover for all four presets");
}
