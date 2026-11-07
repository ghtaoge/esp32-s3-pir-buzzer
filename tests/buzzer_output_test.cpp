#include <assert.h>
#include <stdio.h>
#include <string>
#include <vector>
#include "buzzer_output.h"
#include "buzzer_pattern.h"
using namespace sentinel;

struct FakeIo {
  enum class Failure { None,Attach,Invert,Tone,Quiet,Detach,Level };
  Failure failure=Failure::None;
  bool pwm=false, inverted=false, high=false;
  uint32_t hz=0, duty=0;
  std::vector<std::string> calls;
  bool fails(Failure value) {
    if(failure!=value) return false;
    failure=Failure::None; return true;
  }
  bool attach(uint32_t value) {
    calls.push_back("attach"); pwm=true; hz=value;
    // A partially successful IO operation must also be cleaned up.
    return !fails(Failure::Attach);
  }
  bool invert(bool value) {
    calls.push_back("invert");
    if(fails(Failure::Invert)) return false;
    inverted=value; return true;
  }
  bool tone(uint32_t value) {
    calls.push_back("tone"); assert(pwm);
    if(fails(Failure::Tone)) return false;
    hz=value; duty=512; return true;
  }
  bool quiet() {
    calls.push_back("quiet");
    if(fails(Failure::Quiet)) return false;
    duty=0; if(pwm) high=inverted; return true;
  }
  bool detach() {
    calls.push_back("detach");
    if(fails(Failure::Detach)) return false;
    pwm=false; return true;
  }
  bool level(bool value) {
    calls.push_back(value?"HIGH":"LOW");
    if(fails(Failure::Level)) return false;
    high=value; return true;
  }
};

int main() {
  for(bool low:{false,true}) {
    FakeIo io; BuzzerOutput<FakeIo> output(io);
    assert(output.configure(false,low));
    assert(output.ready() && !output.sounding() && !output.pwmAttached());
    assert(!io.pwm && io.high==low && output.idleHigh()==low);
    for(const auto& call:io.calls) {
      assert(call!="attach" && call!="tone");
      assert(call!=(low?"LOW":"HIGH")); // No wrong-polarity pulse during setup.
    }
    // Setup and repeated idle loops must never allocate PWM or keep rewriting IO.
    const auto idleCalls=io.calls.size();
    for(unsigned n=0;n<10000;++n) assert(output.write(false,2000));
    assert(io.calls.size()==idleCalls);
    assert(output.write(true,2000) && io.pwm && io.duty==512 && io.inverted==low);
    assert(output.sounding() && output.pwmAttached());
    const auto playingCalls=io.calls.size();
    for(unsigned n=0;n<1000;++n) assert(output.write(true,2000));
    assert(io.calls.size()==playingCalls);
    assert(output.write(true,2500) && io.hz==2500);
    assert(output.stop() && !io.pwm && io.high==low && !output.sounding());
    assert(!output.pwmAttached() && io.duty==0);
    const auto end=io.calls.size();
    assert(io.calls[end-3]=="quiet" && io.calls[end-2]=="detach");
    // Stop must reassert the physical idle even when the cached flag is false.
    io.high=!low; assert(output.stop(true) && io.high==low && !io.pwm);
    assert(output.configure(true,low));
    assert(output.write(true,2000) && io.high!=low && !io.pwm);
    assert(output.stop() && io.high==low);
    assert(output.write(true,2000));
    assert(output.configure(false,!low)); // Mode/polarity switch cancels output.
    assert(!output.sounding() && !io.pwm && io.high!=low);
  }
  for(auto failure:{FakeIo::Failure::Attach,FakeIo::Failure::Invert,FakeIo::Failure::Tone}) {
    FakeIo io; BuzzerOutput<FakeIo> output(io);
    assert(output.configure(false,true)); io.failure=failure;
    assert(!output.write(true,2000));
    assert(!output.ready() && !output.sounding() && !output.pwmAttached());
    assert(!io.pwm && io.high && io.duty==0);
    const auto failedCalls=io.calls.size();
    for(unsigned n=0;n<10000;++n) assert(!output.write(true,2000));
    assert(io.calls.size()==failedCalls); // No rapid allocation/retry loop.
    assert(output.configure(false,true) && output.write(true,2000));
    assert(output.stop() && !io.pwm && io.high);
  }
  for(auto failure:{FakeIo::Failure::Quiet,FakeIo::Failure::Detach,FakeIo::Failure::Level}) {
    FakeIo io; BuzzerOutput<FakeIo> output(io);
    assert(output.configure(false,false) && output.write(true,2000));
    io.failure=failure;
    assert(!output.stop(true) && !output.ready() && !output.sounding());
    if(failure!=FakeIo::Failure::Detach) assert(!io.pwm && !output.pwmAttached());
    else assert(io.pwm && output.pwmAttached()); // Never claim a failed detach succeeded.
    assert(output.stop(true) && !io.pwm && !output.pwmAttached() && !io.high);
    assert(!output.ready()); // Physical cleanup alone must not hide the fault.
    assert(output.configure(false,false) && output.ready());
  }
  {
    FakeIo io; BuzzerOutput<FakeIo> output(io);
    assert(output.configure(false,true) && output.write(true,2000));
    io.failure=FakeIo::Failure::Tone; // Failure while a previous pitch is sounding.
    assert(!output.write(true,2500) && !output.sounding() && !output.ready());
    assert(!io.pwm && io.high && io.duty==0);
    assert(output.configure(false,true));
    io.failure=FakeIo::Failure::Level;
    assert(!output.configure(true,false));
    assert(output.configure(false,true)); // A config transaction can restore its old output.
    assert(output.ready() && !output.sounding() && !io.pwm && io.high);
  }
  {
    FakeIo io; BuzzerOutput<FakeIo> output(io);
    io.failure=FakeIo::Failure::Level;
    assert(!output.configure(false,true) && !output.ready());
    assert(output.configure(false,true) && io.high && !io.pwm);
    assert(output.configure(true,false)); io.failure=FakeIo::Failure::Level;
    assert(!output.write(true,2000) && !output.ready() && !output.sounding());
    assert(!io.high && !io.pwm);
  }
  for(auto sound:{Sound::Single,Sound::Double,Sound::Chime,Sound::Siren}) {
    FakeIo io; BuzzerOutput<FakeIo> output(io); MotionAlarm alarm; Config config;
    config.sound=sound; config.beepMs=1000; config.warmupMs=0;
    alarm.begin(0,config); assert(output.configure(false,true) && alarm.test(0));
    for(uint32_t now=0;now<=1000;++now) {
      alarm.tick(now,false);
      const auto sample=sampleBuzzer(sound,config.toneHz,now);
      assert(output.write(alarm.sounding && sample.enabled,sample.hz));
      if(!alarm.sounding || !sample.enabled) assert(!io.pwm && io.high);
    }
    assert(!alarm.sounding && !output.sounding() && !io.pwm && io.high);
  }
  puts("PASS buzzer output: static idle/polarity, lazy PWM, bounded patterns, forced stop, failure cleanup/recovery and no retry loops");
}
