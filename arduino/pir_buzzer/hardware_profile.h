#pragma once
#include <stdint.h>
#include <string.h>
#include "motion_alarm.h"

namespace sentinel {
namespace hardware {
// This release targets the user's three-wire HC-SR505 module. This is an
// explicit build profile, not sensor auto-detection or a radar-timeout fallback.
constexpr char SensorModel[]="HC-SR505";
constexpr uint8_t PirPin=13, BuzzerPin=7;
constexpr bool RadarSupported=false;

// A legacy saved sensor choice must not redirect this profile to UART radar.
// Preserve every other setting, including buzzer type and inactive polarity.
inline bool migrateStoredConfig(Config& config) {
  if(!RadarSupported && config.radar) { config.radar=false; return true; }
  return false;
}
inline const char* configurationError(const Config& config) {
  return !RadarSupported && config.radar?"unsupported_sensor":nullptr;
}
inline const char* patchFieldError(const char* field) {
  return !RadarSupported && (!strcmp(field,"radarMaxGate") || !strcmp(field,"radarMotionThreshold") || !strcmp(field,"radarStillThreshold"))
    ?"unsupported_sensor":nullptr;
}
}
}
