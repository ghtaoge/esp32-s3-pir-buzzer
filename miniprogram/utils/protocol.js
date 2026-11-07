/* Shared by WeChat, the PC console and Node tests. No platform dependencies. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SentinelProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const UUIDS = Object.freeze({
    service: '7b6a0001-6c2d-4b7e-9f10-15a2b3c4d5e6',
    rx: '7b6a0002-6c2d-4b7e-9f10-15a2b3c4d5e6',
    tx: '7b6a0003-6c2d-4b7e-9f10-15a2b3c4d5e6'
  });
  const DEFAULT_CONFIG = Object.freeze({
    sensor: 'pir', armed: true, muted: false,
    beepMs: 3000, cooldownMs: 1000, confirmMs: 200, releaseMs: 500,
    warmupMs: 30000, buzzerMode: 'passive', activeLow: false, toneHz: 2000, sound: 'single',
    radarMaxGate: 4, radarMotionThreshold: 35, radarStillThreshold: 45
  });
  const LIMITS = Object.freeze({
    beepMs: [100, 10000], cooldownMs: [0, 10000], confirmMs: [20, 2000],
    releaseMs: [50, 5000], warmupMs: [0, 120000], toneHz: [200, 5000],
    radarMaxGate: [2, 8], radarMotionThreshold: [0, 100], radarStillThreshold: [0, 100]
  });
  let sessionCounter = 0;
  function newSession() {
    const words = new Uint32Array(2);
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(words);
    else { words[0] = Date.now() >>> 0; words[1] = (Math.floor(Math.random() * 4294967296) ^ ++sessionCounter) >>> 0; }
    return Array.from(words, value => ('00000000' + value.toString(16)).slice(-8)).join('');
  }
  function plain(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  }
  function validateConfig(patch, base) {
    if (!plain(patch)) throw new Error('config must be an object');
    const next = Object.assign({}, DEFAULT_CONFIG, base || {});
    Object.keys(patch).forEach(function (key) {
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) throw new Error('Unknown config field: ' + key);
      const value = patch[key];
      if (Object.prototype.hasOwnProperty.call(LIMITS, key)) {
        const bounds = LIMITS[key];
        if (!Number.isSafeInteger(value) || value < bounds[0] || value > bounds[1])
          throw new Error(key + ' must be an integer in ' + bounds.join('..'));
      } else if (typeof DEFAULT_CONFIG[key] === 'boolean') {
        if (typeof value !== 'boolean') throw new Error(key + ' must be boolean');
      } else {
        const choices = {sensor:['pir','radar'],buzzerMode:['active','passive'],sound:['single','double','chime','siren']};
        if (!choices[key] || !choices[key].includes(value)) throw new Error('Invalid ' + key);
      }
      next[key] = value;
    });
    return next;
  }
  // WeChat does not consistently provide TextEncoder/TextDecoder. These codecs
  // validate UTF-8 rather than corrupting code points split across BLE packets.
  function utf8Encode(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      let cp = text.charCodeAt(i);
      if (cp >= 0xd800 && cp <= 0xdbff) {
        const low = text.charCodeAt(i + 1);
        if (low >= 0xdc00 && low <= 0xdfff) { cp = 0x10000 + ((cp - 0xd800) << 10) + low - 0xdc00; i++; }
        else cp = 0xfffd;
      } else if (cp >= 0xdc00 && cp <= 0xdfff) cp = 0xfffd;
      if (cp < 0x80) bytes.push(cp);
      else if (cp < 0x800) bytes.push(0xc0 | cp >> 6, 0x80 | cp & 63);
      else if (cp < 0x10000) bytes.push(0xe0 | cp >> 12, 0x80 | cp >> 6 & 63, 0x80 | cp & 63);
      else bytes.push(0xf0 | cp >> 18, 0x80 | cp >> 12 & 63, 0x80 | cp >> 6 & 63, 0x80 | cp & 63);
    }
    return new Uint8Array(bytes);
  }
  function asBytes(input) {
    if (input instanceof Uint8Array) return input;
    if (input instanceof ArrayBuffer) return new Uint8Array(input);
    if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    throw new Error('Expected bytes');
  }
  function utf8Decode(input) {
    const bytes = asBytes(input);
    let text = '';
    for (let i = 0; i < bytes.length;) {
      const first = bytes[i++];
      let cp, count, minimum;
      if (first < 0x80) { text += String.fromCharCode(first); continue; }
      if (first >= 0xc2 && first <= 0xdf) { cp = first & 31; count = 1; minimum = 0x80; }
      else if (first >= 0xe0 && first <= 0xef) { cp = first & 15; count = 2; minimum = 0x800; }
      else if (first >= 0xf0 && first <= 0xf4) { cp = first & 7; count = 3; minimum = 0x10000; }
      else throw new Error('Invalid UTF-8');
      if (i + count > bytes.length) throw new Error('Incomplete UTF-8');
      while (count--) {
        const next = bytes[i++];
        if ((next & 0xc0) !== 0x80) throw new Error('Invalid UTF-8 continuation');
        cp = cp << 6 | next & 63;
      }
      if (cp < minimum || cp > 0x10ffff || cp >= 0xd800 && cp <= 0xdfff) throw new Error('Invalid UTF-8 code point');
      if (cp < 0x10000) text += String.fromCharCode(cp);
      else { cp -= 0x10000; text += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023)); }
    }
    return text;
  }
  function encodeFrame(message) {
    const bytes = utf8Encode(JSON.stringify(message) + '\n');
    if (bytes.length > 2048) throw new Error('Protocol frame exceeds 2048 bytes');
    return bytes;
  }
  function chunkBytes(input, size) {
    const bytes = asBytes(input);
    size = size === undefined ? 20 : size;
    if (!Number.isInteger(size) || size < 1 || size > 2048) throw new Error('Invalid chunk size');
    const chunks = [];
    for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
    return chunks;
  }
  class LineDecoder {
    constructor(options) {
      options = options || {};
      this.maxBytes = options.maxBytes || 2048;
      if (!Number.isInteger(this.maxBytes) || this.maxBytes < 2 || this.maxBytes > 65536) throw new Error('Invalid frame capacity');
      this.onError = options.onError || function () {};
      this.buffer = new Uint8Array(this.maxBytes);
      this.reset();
    }
    reset() { this.used = 0; this.discarding = false; }
    push(input) {
      const bytes = asBytes(input), frames = [];
      for (let i = 0; i < bytes.length; i++) {
        const byte = bytes[i];
        if (byte === 10) {
          if (!this.discarding && this.used) {
            const length = this.buffer[this.used - 1] === 13 ? this.used - 1 : this.used;
            if (length) {
              try {
                const message = JSON.parse(utf8Decode(this.buffer.subarray(0, length)));
                if (!plain(message)) throw new Error('Protocol frame must be an object');
                frames.push(message);
              } catch (error) { this.onError(error); }
            }
          }
          this.reset();
        } else if (!this.discarding) {
          if (this.used >= this.maxBytes - 1) {
            this.used = 0; this.discarding = true;
            this.onError(new Error('Protocol frame too large'));
          } else this.buffer[this.used++] = byte;
        }
      }
      return frames;
    }
  }
  class RpcClient {
    constructor(options) {
      if (!options || typeof options.write !== 'function') throw new Error('write is required');
      this.write = options.write;
      this.onEvent = options.onEvent || function () {};
      this.onFatal = options.onFatal || function () {};
      this.timeoutMs = options.timeoutMs || 5000;
      this.maxQueue = options.maxQueue || 16;
      this.closed = false; this.sequence = 0; this.session = newSession(); this.queue = []; this.pending = null;
      this.decoder = new LineDecoder({ onError: error => this.close(error) });
    }
    request(op, fields) {
      if (this.closed) return Promise.reject(new Error('Connection is closed'));
      if (this.queue.length + (this.pending ? 1 : 0) >= this.maxQueue) return Promise.reject(new Error('Command queue is full'));
      if (typeof op !== 'string' || !op || fields !== undefined && !plain(fields)) return Promise.reject(new Error('Invalid request'));
      if (fields && ('id' in fields || 'op' in fields || 'session' in fields)) return Promise.reject(new Error('Reserved request field'));
      return new Promise((resolve, reject) => {
        const id = this.sequence = this.sequence % 0x7fffffff + 1;
        let frame;
        try { frame = encodeFrame(Object.assign({}, fields || {}, { id: id, op: op, session: this.session })); }
        catch (error) { reject(error); return; }
        this.queue.push({id, frame, resolve, reject}); this.pump();
      });
    }
    pump() {
      if (this.closed || this.pending || !this.queue.length) return;
      const task = this.pending = this.queue.shift();
      task.timer = setTimeout(() => this.close(new Error('Device response timed out; reconnect before retrying')), this.timeoutMs);
      Promise.resolve().then(() => {
        if (this.closed || this.pending !== task) throw new Error('Connection is closed');
        return this.write(task.frame);
      }).then(() => { task.writeDone = true; this.finish(task); }, error => this.close(error));
    }
    finish(task) {
      if (this.pending !== task || !task.writeDone || !task.reply) return;
      clearTimeout(task.timer); this.pending = null;
      if (task.reply.ok) task.resolve(task.reply.data);
      else task.reject(Object.assign(new Error(task.reply.message || task.reply.error || 'Device rejected command'), {code: task.reply.error}));
      this.pump();
    }
    receive(bytes) {
      if (this.closed) return;
      let frames;
      try { frames = this.decoder.push(bytes); }
      catch (error) { this.close(error); return; }
      if (this.closed) return;
      frames.forEach(message => {
        if (this.closed) return;
        if (typeof message.event === 'string') {
          try { this.onEvent(message.event, message.data); } catch (_) { /* UI callbacks cannot corrupt the wire session. */ }
        } else if (this.pending && message.session === this.session && message.id === this.pending.id) {
          if (typeof message.ok !== 'boolean') { this.close(new Error('Malformed response')); return; }
          this.pending.reply = message; this.finish(this.pending);
        }
      });
    }
    close(reason) {
      if (this.closed) return;
      this.closed = true;
      const error = reason instanceof Error ? reason : new Error(reason || 'Connection closed');
      if (this.pending) { clearTimeout(this.pending.timer); this.pending.reject(error); this.pending = null; }
      this.queue.splice(0).forEach(task => task.reject(error)); this.decoder.reset();
      try { this.onFatal(error); } catch (_) { /* Cleanup is best effort. */ }
    }
  }
  return {UUIDS, DEFAULT_CONFIG, LIMITS, validateConfig, utf8Encode, utf8Decode, encodeFrame, chunkBytes, LineDecoder, RpcClient};
});
