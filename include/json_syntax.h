#pragma once
#include <stddef.h>
#include <string.h>

namespace sentinel {
// ArduinoJson intentionally accepts some JavaScript extensions and stops after
// the first object. Validate strict JSON first so both clients and firmware
// agree on frame boundaries (including NULs, trailing objects and quoted keys).
class JsonSyntax {
 public:
  static bool valid(const char* data,size_t length) {
    JsonSyntax p(data,length); p.spaces(); if(!p.value(0)) return false; p.spaces(); return p.pos_==p.length_;
  }
 private:
  JsonSyntax(const char* data,size_t length):data_(data),length_(length) {}
  char peek() const { return pos_<length_?data_[pos_]:0; }
  bool take(char c) { if(peek()!=c) return false; ++pos_; return true; }
  void spaces() { while(peek()==' ' || peek()=='\t' || peek()=='\r' || peek()=='\n') ++pos_; }
  static bool digit(char c) { return c>='0' && c<='9'; }
  bool literal(const char* text) { const size_t n=strlen(text); if(n>length_-pos_ || memcmp(data_+pos_,text,n)) return false; pos_+=n; return true; }
  bool string() {
    if(!take('"')) return false;
    while(pos_<length_) {
      const unsigned char c=static_cast<unsigned char>(data_[pos_++]);
      if(c=='"') return true;
      if(c<32) return false;
      if(c!='\\') continue;
      if(pos_==length_) return false;
      const char escape=data_[pos_++];
      if(escape=='u') {
        for(unsigned i=0;i<4;++i) {
          if(pos_==length_) return false;
          const char h=data_[pos_++]; if(!digit(h) && !(h>='a'&&h<='f') && !(h>='A'&&h<='F')) return false;
        }
      } else if(escape!='"' && escape!='\\' && escape!='/' && escape!='b' && escape!='f' && escape!='n' && escape!='r' && escape!='t') return false;
    }
    return false;
  }
  bool number() {
    take('-');
    if(!take('0')) { if(peek()<'1' || peek()>'9') return false; while(digit(peek())) ++pos_; }
    if(take('.')) { if(!digit(peek())) return false; while(digit(peek())) ++pos_; }
    if(take('e') || take('E')) { if(!take('+')) take('-'); if(!digit(peek())) return false; while(digit(peek())) ++pos_; }
    return true;
  }
  bool value(unsigned depth) {
    spaces();
    if(peek()=='{') {
      if(depth>=4) return false;
      ++pos_; spaces(); if(take('}')) return true;
      do { spaces(); if(!string()) return false; spaces(); if(!take(':') || !value(depth+1)) return false; spaces(); if(take('}')) return true; } while(take(','));
      return false;
    }
    if(peek()=='[') {
      if(depth>=4) return false;
      ++pos_; spaces(); if(take(']')) return true;
      do { if(!value(depth+1)) return false; spaces(); if(take(']')) return true; } while(take(','));
      return false;
    }
    if(peek()=='"') return string();
    if(peek()=='t') return literal("true");
    if(peek()=='f') return literal("false");
    if(peek()=='n') return literal("null");
    return number();
  }
  const char* data_; size_t length_,pos_=0;
};
}
