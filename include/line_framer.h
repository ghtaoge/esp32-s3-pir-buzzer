#pragma once
#include <stddef.h>
#include <stdint.h>

namespace sentinel {
template<size_t Capacity = 2048> class LineFramer {
 public:
  enum class Result { More, Complete, Oversize };
  Result feed(uint8_t byte) {
    if (byte == '\n') {
      if (discard_) { reset(); return Result::Oversize; }
      if (used_ && bytes_[used_ - 1] == '\r') --used_;
      bytes_[used_] = 0; return Result::Complete;
    }
    if (!discard_) {
      if (used_ >= Capacity - 1) { discard_ = true; used_ = 0; }
      else bytes_[used_++] = static_cast<char>(byte);
    }
    return Result::More;
  }
  void poison() { discard_ = true; used_ = 0; }
  void reset() { used_ = 0; discard_ = false; }
  const char* data() const { return bytes_; }
  size_t size() const { return used_; }
 private:
  char bytes_[Capacity]{};
  size_t used_ = 0;
  bool discard_ = false;
};
}
