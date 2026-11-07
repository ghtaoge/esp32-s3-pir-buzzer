#pragma once
#include <ArduinoJson.h>
#include "motion_alarm.h"
#include "buzzer_pattern.h"

namespace sentinel {
inline void configJson(JsonObject out, const Config& c) {
  out["sensor"]=c.radar?"radar":"pir"; out["armed"]=c.armed; out["muted"]=c.muted;
  out["sound"]=soundName(c.sound);
  out["beepMs"]=c.beepMs; out["cooldownMs"]=c.cooldownMs; out["confirmMs"]=c.confirmMs;
  out["releaseMs"]=c.releaseMs; out["warmupMs"]=c.warmupMs;
  out["buzzerMode"]=c.active?"active":"passive"; out["activeLow"]=c.activeLow; out["toneHz"]=c.toneHz;
  out["radarMaxGate"]=c.radarMaxGate; out["radarMotionThreshold"]=c.radarMotionThreshold;
  out["radarStillThreshold"]=c.radarStillThreshold;
}
// Work on a copy. A single bad field prevents all changes.
inline bool parseConfig(JsonVariantConst value, const Config& old, Config& result, const char*& problem) {
  if (!value.is<JsonObjectConst>()) { problem="config must be an object"; return false; }
  Config next=old;
  for (JsonPairConst pair:value.as<JsonObjectConst>()) {
    const char* key=pair.key().c_str(); JsonVariantConst v=pair.value();
    if(strlen(key)!=pair.key().size()) { problem="unknown configuration key"; return false; }
    if (!strcmp(key,"sensor") || !strcmp(key,"buzzerMode") || !strcmp(key,"sound")) {
      if (!v.is<const char*>()) { problem="enum field must be a string"; return false; }
      const char* text=v.as<const char*>();
      if(strlen(text)!=v.as<JsonString>().size()) { problem="invalid enum string"; return false; }
      if (!strcmp(key,"sound")) {
        if(!strcmp(text,"single")) next.sound=Sound::Single;
        else if(!strcmp(text,"double")) next.sound=Sound::Double;
        else if(!strcmp(text,"chime")) next.sound=Sound::Chime;
        else if(!strcmp(text,"siren")) next.sound=Sound::Siren;
        else { problem="invalid sound"; return false; }
      } else if (!strcmp(key,"sensor")) {
        if (strcmp(text,"pir") && strcmp(text,"radar")) { problem="invalid sensor"; return false; }
        next.radar=!strcmp(text,"radar");
      } else {
        if (strcmp(text,"active") && strcmp(text,"passive")) { problem="invalid buzzerMode"; return false; }
        next.active=!strcmp(text,"active");
      }
      continue;
    }
    bool* boolean=nullptr;
    if (!strcmp(key,"armed")) boolean=&next.armed;
    else if (!strcmp(key,"muted")) boolean=&next.muted;
    else if (!strcmp(key,"activeLow")) boolean=&next.activeLow;
    if (boolean) {
      if (!v.is<bool>()) { problem="boolean field requires true or false"; return false; }
      *boolean=v.as<bool>(); continue;
    }
    uint32_t low=0,high=0; uint32_t* dest=nullptr; uint8_t* small=nullptr;
    if (!strcmp(key,"beepMs")) { dest=&next.beepMs; low=100; high=10000; }
    else if (!strcmp(key,"cooldownMs")) { dest=&next.cooldownMs; high=10000; }
    else if (!strcmp(key,"confirmMs")) { dest=&next.confirmMs; low=20; high=2000; }
    else if (!strcmp(key,"releaseMs")) { dest=&next.releaseMs; low=50; high=5000; }
    else if (!strcmp(key,"warmupMs")) { dest=&next.warmupMs; high=120000; }
    else if (!strcmp(key,"toneHz")) { dest=&next.toneHz; low=200; high=5000; }
    else if (!strcmp(key,"radarMaxGate")) { small=&next.radarMaxGate; low=2; high=8; }
    else if (!strcmp(key,"radarMotionThreshold")) { small=&next.radarMotionThreshold; high=100; }
    else if (!strcmp(key,"radarStillThreshold")) { small=&next.radarStillThreshold; high=100; }
    else { problem="unknown configuration key"; return false; }
    if (v.is<bool>() || !v.is<uint32_t>()) { problem="numeric field must be an unsigned integer"; return false; }
    const uint32_t number=v.as<uint32_t>();
    if (number<low || number>high) { problem="configuration value outside allowed range"; return false; }
    if (dest) *dest=number; else *small=static_cast<uint8_t>(number);
  }
  result=next; return true;
}
}
