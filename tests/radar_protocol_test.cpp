#include <assert.h>
#include <stdio.h>
#include <vector>
#include "radar_config.h"
using namespace sentinel;

static void ack(RadarConfigEngine& e,uint16_t cmd,const std::vector<uint8_t>& extra={}) {
  uint8_t p[128]{}; put16(p,cmd|0x100); memcpy(p+4,extra.data(),extra.size()); e.ack(p,4+extra.size());
}
static std::vector<uint8_t> params(uint8_t gate,uint8_t moving,uint8_t still) {
  std::vector<uint8_t> p={0xAA,8,gate,gate};
  for(unsigned i=0;i<9;++i) p.push_back(moving);
  for(unsigned i=0;i<9;++i) p.push_back(still);
  p.push_back(5); p.push_back(0); return p;
}
static uint16_t command(RadarConfigEngine& e,uint32_t now=0) {
  uint8_t p[32]{}; const size_t n=e.command(p,now); assert(n>=12 && n<=32);
  assert(static_cast<size_t>(le16(p+4))+10==n); assert(!memcmp(p,"\xFD\xFC\xFB\xFA",4));
  assert(!memcmp(p+n-4,"\x04\x03\x02\x01",4)); return le16(p+6);
}
int main() {
  {
    RadarConfigEngine e; Config c; c.radar=true;
    assert(e.start(c,0)); assert(command(e)==0xFF); ack(e,0xFF);
    assert(command(e)==0xAB); ack(e,0xAB,{0,0});
    assert(command(e)==0x61); ack(e,0x61,params(6,50,60));
    assert(command(e)==0x60); ack(e,0x60);
    assert(command(e)==0x64); ack(e,0x64);
    assert(command(e)==0x61); ack(e,0x61,params(4,35,45));
    assert(command(e)==0xFE); ack(e,0xFE);
    assert(!e.busy && e.complete && e.success && e.ready);
  }
  {
    RadarConfigEngine e; Config c; assert(e.start(c,UINT32_MAX-50));
    assert(command(e,UINT32_MAX-50)==0xFF);
    e.tick(648); assert(e.busy); e.tick(649);
    assert(!e.busy && !e.success && !e.ready && !strcmp(e.error,"radar_timeout"));
  }
  {
    RadarConfigEngine e; Config c; e.start(c,0); command(e); ack(e,0xFF); command(e); ack(e,0xAB,{1,0});
    assert(e.complete && !e.success && !strcmp(e.error,"radar_requires_075m_resolution"));
  }
  {
    // Bad readback never reports success. Rollback restores each old gate and
    // verifies the actual old parameters before finishing the failed operation.
    RadarConfigEngine e; Config c; e.ready=true; e.start(c,0);
    command(e); ack(e,0xFF); command(e); ack(e,0xAB,{0,0});
    command(e); ack(e,0x61,params(6,50,60)); command(e); ack(e,0x60); command(e); ack(e,0x64);
    command(e); ack(e,0x61,params(4,36,45));
    assert(e.busy && !e.complete); assert(command(e)==0xFF); ack(e,0xFF);
    assert(command(e)==0x60); ack(e,0x60);
    for(unsigned i=0;i<9;++i) { assert(command(e)==0x64); ack(e,0x64); }
    assert(command(e)==0x61); ack(e,0x61,params(6,50,60)); assert(command(e)==0xFE); ack(e,0xFE);
    assert(e.complete && !e.success && e.ready && !strcmp(e.error,"radar_readback_mismatch"));
  }
  {
    RadarConfigEngine e; Config c; e.ready=true; e.start(c,0);
    command(e); ack(e,0xFF); command(e); ack(e,0xAB,{0,0}); command(e); ack(e,0x61,params(6,50,60));
    assert(command(e)==0x60);
    uint8_t rejected[4]{}; put16(rejected,0x160); put16(rejected+2,1); e.ack(rejected,4);
    assert(e.busy && !e.ready); assert(command(e)==0xFF);
    put16(rejected,0x1FF); e.ack(rejected,4);
    assert(e.complete && !e.success && !e.ready && !strcmp(e.error,"radar_rollback_failed"));
  }
  {
    RadarParser p; std::vector<uint8_t> data={0xF4,0xF3,0xF2,0xF1,13,0,2,0xAA,3,100,0,80,50,0,60,100,0,0x55,0,0xF8,0xF7,0xF6,0xF5};
    RadarParser::Kind kind=RadarParser::Kind::None;
    for(uint8_t b:data) kind=p.feed(b);
    assert(kind==RadarParser::Kind::Data); RadarSample s; assert(p.sample(s));
    assert(s.motion && s.present && s.distanceCm==100 && s.motionEnergy==80 && s.stillEnergy==60);
    // Malformed large lengths and arbitrary bytes do not prevent resync.
    for(unsigned i=0;i<100000;++i) p.feed(static_cast<uint8_t>(i*73));
    for(uint8_t b:std::vector<uint8_t>{0xF4,0xF3,0xF2,0xF1,0xFF,0xFF}) p.feed(b);
    for(uint8_t b:data) kind=p.feed(b);
    assert(kind==RadarParser::Kind::Data && p.sample(s));
    data[8]=2; for(uint8_t b:data) kind=p.feed(b);
    assert(kind==RadarParser::Kind::Data && p.sample(s) && s.present && !s.motion && s.distanceCm==50);
    data[18]=0x54; for(uint8_t b:data) kind=p.feed(b); assert(kind==RadarParser::Kind::Data && !p.sample(s));
  }
  puts("PASS radar protocol: bounds, resync, data/presence separation, real ACK/readback, rollback, timeout rollover");
}
