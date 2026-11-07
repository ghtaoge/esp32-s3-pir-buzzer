#pragma once
#include <stdint.h>

namespace sentinel {
// Hardware IO is injected so the output lifecycle and failure cleanup can be
// verified without pretending that a software flag measures the actual sound.
// quiet()/detach() must be idempotent when no PWM is attached.
template<class Io> class BuzzerOutput {
 public:
  explicit BuzzerOutput(Io& io):io_(io) {}
  bool configure(bool active,bool activeLow) {
    const bool previousStopped=!configured_ || stop(true);
    active_=active; activeLow_=activeLow; configured_=true; idleApplied_=false;
    const bool stopped=stop(true);
    ready_=previousStopped && stopped;
    return ready_;
  }
  bool write(bool on,uint32_t hz,bool force=false) {
    if(!on) return stop(force);
    if(!ready_) return false; // A failed output needs explicit reconfiguration.
    if(on_ && (active_ || hz_==hz)) return true;
    if(active_) {
      if(!io_.level(!activeLow_)) return fail();
    } else {
      if(!attached_) {
        // Mark the attempt before calling into IO: failure cleanup must also
        // handle an adapter that partially attached a peripheral before failing.
        attached_=true; idleApplied_=false;
        if(!io_.attach(hz) || !io_.invert(activeLow_)) return fail();
      }
      if(!io_.tone(hz)) return fail();
    }
    on_=true; hz_=active_?0:hz; idleApplied_=false;
    return true;
  }
  bool stop(bool force=false) {
    if(!configured_) return false;
    if(!force && !on_ && idleApplied_) return ready_;
    bool ok=true;
    if(attached_ || force) {
      // Set zero duty before detaching so a reused LEDC channel cannot inherit
      // the previous tone's duty. Inversion maps zero duty to the idle level.
      const bool quiet=io_.quiet();
      const bool detached=io_.detach();
      attached_=!detached;
      ok=quiet && detached;
    }
    const bool staticLevel=io_.level(activeLow_);
    on_=false; hz_=0; idleApplied_=true;
    if(!ok || !staticLevel) ready_=false;
    return ok && staticLevel;
  }
  bool ready() const { return ready_; }
  bool sounding() const { return on_; }
  bool pwmAttached() const { return attached_; }
  bool idleHigh() const { return activeLow_; }
 private:
  bool fail() { ready_=false; stop(true); return false; }
  Io& io_;
  bool configured_=false, active_=false, activeLow_=false;
  bool ready_=false, on_=false, attached_=false, idleApplied_=false;
  uint32_t hz_=0;
};
}
