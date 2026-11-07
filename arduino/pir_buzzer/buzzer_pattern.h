#pragma once
#include "motion_alarm.h"

namespace sentinel {
struct BuzzerSample { bool enabled; uint32_t hz; };
inline uint32_t boundedTone(uint32_t hz) { return hz<200?200:hz>5000?5000:hz; }
inline BuzzerSample sampleBuzzer(Sound sound,uint32_t toneHz,uint32_t elapsedMs) {
  const uint32_t part=elapsedMs%800;
  switch(sound) {
    case Sound::Double: return {part<120 || (part>=220 && part<340),boundedTone(toneHz)};
    case Sound::Chime: return {part<400,boundedTone(part<200?toneHz:(toneHz*4+2)/5)};
    case Sound::Siren: return {true,boundedTone((elapsedMs/150)%2?(toneHz*5+2)/4:(toneHz*3+2)/4)};
    default: return {true,boundedTone(toneHz)};
  }
}
inline const char* soundName(Sound s) {
  switch(s) { case Sound::Double:return "double"; case Sound::Chime:return "chime"; case Sound::Siren:return "siren"; default:return "single"; }
}
}
