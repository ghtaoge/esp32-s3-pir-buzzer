#include <cassert>
#include <chrono>
#include <cstdio>
#include "motion_alarm.h"
#include "log_store.h"

int main() {
  using Clock=std::chrono::steady_clock;
  sentinel::Config config;
  config.warmupMs=0; config.beepMs=100; config.cooldownMs=0;
  config.confirmMs=20; config.releaseMs=50;
  sentinel::MotionAlarm detector; detector.begin(0,config);
  auto started=Clock::now();
  for(uint32_t n=0;n<10000000;++n) detector.tick(n,n%400>=200);
  auto elapsed=std::chrono::duration<double,std::milli>(Clock::now()-started).count();
  assert(detector.triggers==25000);
  std::printf("detector: 10000000 simulated ticks, 25000 expected episodes, %.3f ms host CPU\n",elapsed);
  sentinel::LogCache cache;
  started=Clock::now();
  for(uint64_t n=1;n<=100000;++n) {
    sentinel::LogRecord entry{}; entry.seq=n; entry.uptimeMs=n; sentinel::seal(entry);
    cache.insert(entry);
  }
  elapsed=std::chrono::duration<double,std::milli>(Clock::now()-started).count();
  assert(cache.count==1000 && cache.oldest==99001 && cache.latest==100000);
  std::printf("RAM log mirror: 100000 CRC/inserts/retention scans, fixed %zu bytes, %.3f ms host CPU\n",sizeof(cache),elapsed);
  std::puts("Host software only; does not measure radio, flash, GPIO or physical sensor latency.");
}
