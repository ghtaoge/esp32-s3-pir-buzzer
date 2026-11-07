#include <assert.h>
#include <stdio.h>
#include "config_json.h"
using namespace sentinel;
static bool parse(const char* text,Config& c) { JsonDocument d; assert(!deserializeJson(d,text)); const char* error=""; return parseConfig(d.as<JsonVariantConst>(),Config{},c,error); }
int main() {
  Config c; assert(parse("{\"beepMs\":100,\"muted\":true,\"sensor\":\"radar\"}",c)); assert(c.beepMs==100 && c.muted && c.radar);
  const char* invalid[]={"null","[]","{\"beepMs\":99}","{\"beepMs\":10001}","{\"beepMs\":100.5}","{\"beepMs\":true}","{\"beepMs\":\"100\"}","{\"beepMs\":-1}","{\"armed\":1}","{\"toneHz\":5001}","{\"radarMaxGate\":1}","{\"sensor\":\"mmwave\"}","{\"unknown\":1}","{\"beepMs\":100,\"armed\":false,\"unknown\":1}"};
  for(const char* text:invalid) { c=Config{}; assert(!parse(text,c)); assert(c.beepMs==3000 && c.armed && !c.radar); }
  assert(parse("{\"radarMaxGate\":8,\"radarMotionThreshold\":0,\"radarStillThreshold\":100,\"cooldownMs\":0,\"warmupMs\":120000,\"activeLow\":true}",c));
  JsonDocument d; configJson(d.to<JsonObject>(),c); Config roundtrip; const char* problem="";
  assert(parseConfig(d.as<JsonVariantConst>(),Config{},roundtrip,problem));
  assert(roundtrip.radarMaxGate==8 && roundtrip.radarMotionThreshold==0 && roundtrip.activeLow && roundtrip.warmupMs==120000);
  assert(parse("{\"sound\":\"double\"}",c) && c.sound==Sound::Double);
  assert(parse("{\"sound\":\"chime\"}",c) && c.sound==Sound::Chime);
  assert(parse("{\"sound\":\"siren\"}",c) && c.sound==Sound::Siren);
  assert(!parse("{\"sound\":\"music\"}",c) && !parse("{\"sound\":1}",c));
  assert(!parse("{\"sensor\":\"pir\\u0000evil\"}",c));
  assert(!parse("{\"armed\\u0000evil\":false}",c));
  puts("PASS config JSON: strict types, ranges, unknown keys, atomic rejection, roundtrip");
}
