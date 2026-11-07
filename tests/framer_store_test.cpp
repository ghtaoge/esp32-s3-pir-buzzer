#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "line_framer.h"
#include "log_store.h"
#include "json_syntax.h"
using namespace sentinel;
int main() {
  const char* validJson[]={"{}"," {\"id\":1,\"op\":\"get\"} ","{\"x\":[true,false,null,-1.5e+2,\"a\\u4E2D\"]}"};
  for(const char* p:validJson) assert(JsonSyntax::valid(p,strlen(p)));
  const char* badJson[]={"", "{'id':1}","{id:1}","{}{}","{}x","{\"x\":NaN}","{\"x\":01}","{\"x\":1.}","{\"x\":1e}","{\"x\":true,}","{\"x\":\"\\uGGGG\"}"};
  for(const char* p:badJson) assert(!JsonSyntax::valid(p,strlen(p)));
  const char nul[]={ '{','}',0,'x' }; assert(!JsonSyntax::valid(nul,sizeof(nul)));
  LineFramer<> f;
  for(unsigned i=0;i<2047;++i) assert(f.feed('a')==LineFramer<>::Result::More);
  assert(f.feed('\n')==LineFramer<>::Result::Complete && f.size()==2047); f.reset();
  for(unsigned i=0;i<2048;++i) f.feed('a');
  const char* attack="{\"id\":1,\"op\":\"clear\"}"; for(const char* p=attack;*p;++p) f.feed(*p);
  assert(f.feed('\n')==LineFramer<>::Result::Oversize); assert(f.size()==0);
  f.feed('a'); f.feed('\r'); assert(f.feed('\n')==LineFramer<>::Result::Complete && f.size()==1); f.reset();
  f.feed('{'); f.poison(); f.feed('}'); assert(f.feed('\n')==LineFramer<>::Result::Oversize);
  f.feed('o'); f.feed('k'); assert(f.feed('\n')==LineFramer<>::Result::Complete && !strcmp(f.data(),"ok"));
  LogCache cache;
  for(uint64_t i=1;i<=1005;++i) { LogRecord r{}; r.seq=i; seal(r); cache.insert(r); }
  assert(cache.count==1000 && cache.oldest==6 && cache.latest==1005 && !cache.find(5) && cache.find(6));
  cache.clear(1005); assert(cache.count==0 && !cache.find(6) && cache.latest==1005);
  LogRecord r{}; r.seq=1006; seal(r); cache.insert(r); assert(cache.count==1 && cache.oldest==1006 && cache.latest==1006);
  r.energy=1; assert(!valid(r)); r.seq=1007; seal(r); cache.insert(r); assert(cache.count==2);
  cache.clear(1007); r.seq=1000000000002ULL; seal(r); cache.insert(r);
  assert(cache.nextAfter(1007) && cache.nextAfter(1007)->seq==r.seq && !cache.nextAfter(r.seq));
  // Driver failures survive the same CRC/cache path as historical outcomes;
  // unrecognized result codes remain invalid rather than looking successful.
  for(uint8_t result=0;result<=3;++result) {
    LogRecord outcome{}; outcome.seq=1000000000003ULL+result; outcome.result=result; seal(outcome);
    assert(valid(outcome)); cache.insert(outcome);
    const LogRecord* restored=cache.find(outcome.seq);
    assert(restored && restored->result==result && valid(*restored));
  }
  LogRecord unknown{}; unknown.seq=1000000000010ULL; unknown.result=4; seal(unknown);
  assert(!valid(unknown)); cache.insert(unknown); assert(!cache.find(unknown.seq));
  assert(checksum("123456789",9)==0xCBF43926u);
  puts("PASS framing/storage cache: exact limit, discard-through-LF, poison/resync, CRC, overwrite, clear watermark and failed-output records");
}
