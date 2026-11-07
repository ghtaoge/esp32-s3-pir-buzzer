#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <string>
#include "config_json.h"
#include "hardware_profile.h"
using namespace sentinel;

int main() {
  // A valid legacy radar configuration can exist in NVS across firmware uploads.
  // Migrate only its sensor choice; retain sound, timing, arming and polarity.
  JsonDocument legacy;
  const char* oldJson="{\"sensor\":\"radar\",\"armed\":false,\"muted\":true,\"beepMs\":4600,\"cooldownMs\":345,\"confirmMs\":70,\"releaseMs\":650,\"warmupMs\":55000,\"buzzerMode\":\"active\",\"activeLow\":true,\"toneHz\":3300,\"sound\":\"chime\",\"radarMaxGate\":7,\"radarMotionThreshold\":22,\"radarStillThreshold\":33}";
  assert(!deserializeJson(legacy,oldJson));
  Config saved{}; const char* problem="";
  assert(parseConfig(legacy.as<JsonVariantConst>(),Config{},saved,problem));
  assert(saved.radar && !strcmp(hardware::configurationError(saved),"unsupported_sensor"));
  JsonDocument before; configJson(before.to<JsonObject>(),saved);
  assert(hardware::migrateStoredConfig(saved));
  assert(!saved.radar && !hardware::configurationError(saved));
  assert(!hardware::migrateStoredConfig(saved)); // Idempotent after successful persistence.
  JsonDocument migrated; configJson(migrated.to<JsonObject>(),saved);
  for(JsonPairConst pair:before.as<JsonObjectConst>()) {
    if(!strcmp(pair.key().c_str(),"sensor")) assert(!strcmp(migrated["sensor"].as<const char*>(),"pir"));
    else assert(pair.value()==migrated[pair.key().c_str()]);
  }
  // The exact migrated JSON is what NVS writes and reads back.
  std::string bytes; serializeJson(migrated,bytes); JsonDocument disk;
  assert(!deserializeJson(disk,bytes)); Config restarted{};
  assert(parseConfig(disk.as<JsonVariantConst>(),Config{},restarted,problem));
  assert(!restarted.radar && restarted.active && restarted.activeLow && restarted.sound==Sound::Chime && restarted.beepMs==4600);
  // Runtime requests are rejected, not silently rewritten or acknowledged.
  JsonDocument request; assert(!deserializeJson(request,"{\"sensor\":\"radar\",\"beepMs\":100}"));
  Config candidate; assert(parseConfig(request.as<JsonVariantConst>(),restarted,candidate,problem));
  assert(!strcmp(hardware::configurationError(candidate),"unsupported_sensor"));
  assert(!restarted.radar && restarted.beepMs==4600);
  for(const char* field:{"radarMaxGate","radarMotionThreshold","radarStillThreshold"}) {
    JsonDocument patch; patch[field]=4;
    assert(parseConfig(patch.as<JsonVariantConst>(),restarted,candidate,problem));
    assert(!candidate.radar && !strcmp(hardware::patchFieldError(field),"unsupported_sensor"));
    assert(restarted.radarMaxGate==7 && restarted.radarMotionThreshold==22 && restarted.radarStillThreshold==33);
  }
  assert(!hardware::patchFieldError("beepMs") && !hardware::patchFieldError("sound") && !hardware::patchFieldError("warmupMs"));
  Config defaults; assert(!hardware::migrateStoredConfig(defaults) && !hardware::configurationError(defaults));
  assert(defaults.warmupMs==30000 && defaults.beepMs==3000 && !defaults.active && defaults.sound==Sound::Single);
  puts("PASS HC-SR505 profile: legacy migration preserves all other fields, persisted roundtrip, idempotence, runtime radar rejection");
}
