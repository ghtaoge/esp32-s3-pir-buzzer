(function (root, factory) {
  const protocol = typeof module === 'object' && module.exports ? require('../miniprogram/utils/protocol.js') : root.SentinelProtocol;
  const api = factory(protocol);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SentinelTransports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (P) {
  'use strict';
  class SerialTransport {
    constructor(handlers) { Object.assign(this, handlers); this.closed = false; this.kind = 'USB 串口'; }
    assertOpen() { if (this.closed) throw new Error('连接已取消'); }
    async connect() {
      if (!navigator.serial) throw new Error('当前浏览器不支持 USB 串口，请使用桌面版 Chrome 或 Edge');
      try {
        this.port = await navigator.serial.requestPort();
        this.assertOpen();
        this.opening = this.port.open({ baudRate: 115200, bufferSize: 4096 });
        await this.opening;
        this.assertOpen();
        this.writer = this.port.writable.getWriter();
        this.reader = this.port.readable.getReader();
        this.reading = this.readLoop();
      } catch (error) { await this.disconnect(); throw error; }
      return this;
    }
    async readLoop() {
      let reason = new Error('USB 串口已断开');
      try {
        while (!this.closed) {
          const result = await this.reader.read();
          if (result.done) break;
          if (result.value && !this.closed) this.onBytes(result.value);
        }
      } catch (error) { reason = error; }
      finally {
        try { this.reader.releaseLock(); } catch (_) {}
        if (!this.closed) { this.closed = true; this.onDisconnect(reason); }
      }
    }
    async write(bytes) {
      if (this.closed || !this.writer) throw new Error('USB 串口未连接');
      await this.writer.write(bytes);
    }
    disconnect() {
      if (this.closing) return this.closing;
      this.closed = true;
      this.closing = (async () => {
        if (this.opening) await this.opening.catch(() => {});
        if (this.reader) { try { await this.reader.cancel(); } catch (_) {} }
        if (this.reading) await this.reading.catch(() => {});
        if (this.writer) { try { this.writer.releaseLock(); } catch (_) {} this.writer = null; }
        if (this.port) { const port = this.port; this.port = null; try { await port.close(); } catch (_) {} }
      })();
      return this.closing;
    }
  }
  class BluetoothTransport {
    constructor(handlers) {
      Object.assign(this, handlers); this.closed = false; this.kind = '蓝牙 BLE';
      this.changed = event => { if (!this.closed) this.onBytes(new Uint8Array(event.target.value.buffer, event.target.value.byteOffset, event.target.value.byteLength)); };
      this.lost = () => { if (!this.closed) { this.closed = true; this.onDisconnect(new Error('蓝牙已断开，请靠近设备后重新连接')); } };
    }
    assertOpen() { if (this.closed) { if (this.device && this.device.gatt.connected) this.device.gatt.disconnect(); throw new Error('连接已取消'); } }
    async connect() {
      if (!navigator.bluetooth) throw new Error('当前浏览器不支持 Web Bluetooth，请使用 Chrome / Edge 或 USB 串口');
      try {
        this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: [P.UUIDS.service] }, { namePrefix: 'S3-Sentinel-' }], optionalServices: [P.UUIDS.service] });
        this.assertOpen();
        this.device.addEventListener('gattserverdisconnected', this.lost);
        const gatt = await this.device.gatt.connect();
        this.assertOpen();
        const service = await gatt.getPrimaryService(P.UUIDS.service);
        this.assertOpen();
        this.rx = await service.getCharacteristic(P.UUIDS.rx);
        this.assertOpen();
        this.tx = await service.getCharacteristic(P.UUIDS.tx);
        this.assertOpen();
        this.tx.addEventListener('characteristicvaluechanged', this.changed);
        await this.tx.startNotifications();
        if (this.closed || !this.device.gatt.connected) throw new Error('蓝牙在初始化时断开');
      } catch (error) { await this.disconnect(); throw error; }
      return this;
    }
    async write(bytes) {
      if (this.closed || !this.rx) throw new Error('蓝牙未连接');
      for (const chunk of P.chunkBytes(bytes, 20)) {
        if (this.closed) throw new Error('蓝牙已断开');
        if (this.rx.writeValueWithResponse) await this.rx.writeValueWithResponse(chunk);
        else await this.rx.writeValue(chunk);
      }
    }
    async disconnect() {
      this.closed = true;
      if (this.tx) this.tx.removeEventListener('characteristicvaluechanged', this.changed);
      if (this.device) {
        this.device.removeEventListener('gattserverdisconnected', this.lost);
        if (this.device.gatt.connected) this.device.gatt.disconnect();
      }
      this.rx = null; this.tx = null;
    }
  }
  class DemoTransport {
    constructor(handlers, runtime = {}) {
      Object.assign(this, handlers); this.kind = '演示 · 非真实硬件'; this.closed = false;
      this.now = runtime.now || (() => Date.now());
      this.setInterval = runtime.setInterval || ((callback, delay) => globalThis.setInterval(callback, delay));
      this.clearInterval = runtime.clearInterval || (handle => globalThis.clearInterval(handle));
      this.config = { ...P.DEFAULT_CONFIG };
      this.bootAt = this.now(); this.deviceId = 'DEMO-' + this.bootAt;
      this.bootId = 'demo'; this.entries = []; this.sequence = 0; this.timeOffset = null;
      this.motionUntil = 0; this.motionAt = null; this.quietAt = this.bootAt;
      this.awaitRelease = false; this.beepEnd = 0; this.coolEnd = 0; this.beepCooldown = 0;
      this.state = { motion: false, present: false, sounding: false, phase: 'ready', uptimeMs: 0, triggerCount: 0, timeKnown: false, distanceCm: 0, motionEnergy: 0, stillEnergy: 0, radarAgeMs: 0, freeHeap: 180000, minFreeHeap: 175000, loopMaxUs: 350, queueDrops: 0, txDrops: 0 };
      this.decoder = new P.LineDecoder(); this.lastStateAt = 0;
    }
    async connect() { this.timer = this.setInterval(() => this.tick(), 25); return this; }
    send(value) { if (!this.closed) this.onBytes(P.encodeFrame(value)); }
    snapshot() { return { deviceId: this.deviceId, version: '1.0.0-demo', bootId: this.bootId, config: { ...this.config }, state: { ...this.state }, logs: this.logInfo() }; }
    logInfo() { return { oldest: this.entries.length ? this.entries[0].seq : this.sequence + 1, latest: this.sequence, count: this.entries.length, capacity: 1000 }; }
    addLog(type, result) {
      const entry = { seq: ++this.sequence, bootId: this.bootId, uptimeMs: this.now() - this.bootAt, epochMs: this.timeOffset === null ? 0 : this.now() + this.timeOffset, type, result, distanceCm: this.state.distanceCm, energy: this.state.motionEnergy };
      this.entries.push(entry); if (this.entries.length > 1000) this.entries.shift();
      this.send({ event: 'log', data: entry });
    }
    startBeep() { this.state.sounding = true; this.state.phase = 'sounding'; this.beepEnd = this.now() + this.config.beepMs; this.beepCooldown = this.config.cooldownMs; }
    stopBeep() { this.state.sounding = false; this.coolEnd = this.now() + this.beepCooldown; this.awaitRelease = true; this.state.phase = this.now() < this.coolEnd ? 'cooldown' : 'waiting_release'; }
    simulateActivity(durationMs = 500) {
      if (this.closed) return;
      this.motionUntil = this.now() + Math.max(durationMs, this.config.confirmMs + 50); this.motionAt = null;
    }
    tick() {
      if (this.closed) return;
      const now = this.now(); this.state.uptimeMs = now - this.bootAt;
      const motion = now < this.motionUntil;
      this.state.motion = motion; this.state.present = motion;
      this.state.motionEnergy = motion ? 75 : 0; this.state.distanceCm = motion && this.config.sensor === 'radar' ? 150 : 0;
      if (motion) { this.quietAt = null; if (this.motionAt === null) this.motionAt = now; }
      else { this.motionAt = null; if (this.quietAt === null) this.quietAt = now; }
      if (this.state.sounding && now >= this.beepEnd) this.stopBeep();
      if (this.awaitRelease && !this.state.sounding && now >= this.coolEnd && this.quietAt !== null && now - this.quietAt >= this.config.releaseMs) this.awaitRelease = false;
      if (!this.awaitRelease && !this.state.sounding && motion && this.motionAt !== null && now - this.motionAt >= this.config.confirmMs) {
        this.state.triggerCount++;
        const result = !this.config.armed ? 'disarmed' : this.config.muted ? 'muted' : 'sounded';
        this.awaitRelease = true; this.beepCooldown = this.config.cooldownMs;
        if (result === 'sounded') this.startBeep(); else this.coolEnd = now + this.config.cooldownMs;
        this.addLog('motion', result);
      }
      this.state.phase = this.state.sounding ? 'sounding' : now < this.coolEnd ? 'cooldown' : this.awaitRelease ? 'waiting_release' : 'ready';
      if (now - this.lastStateAt >= 200) { this.lastStateAt = now; this.send({ event: 'state', data: { ...this.state } }); }
    }
    async write(bytes) {
      if (this.closed) throw new Error('演示连接已关闭');
      for (const command of this.decoder.push(bytes)) {
        try {
          if (typeof command.session !== 'string' || !/^[0-9a-fA-F]{16}$/.test(command.session)) throw new Error('invalid_session');
          let data;
          if (command.op === 'get') data = this.snapshot();
          else if (command.op === 'time') {
            if (!Number.isSafeInteger(command.epochMs) || command.epochMs < 0) throw new Error('invalid_time');
            this.timeOffset = command.epochMs - this.now(); this.state.timeKnown = true; data = this.snapshot();
          } else if (command.op === 'set') {
            const next = P.validateConfig(command.config, this.config);
            if (this.state.sounding && (!next.armed || next.muted || next.sensor !== this.config.sensor || next.buzzerMode !== this.config.buzzerMode || next.activeLow !== this.config.activeLow || next.toneHz !== this.config.toneHz)) this.stopBeep();
            this.config = next; data = this.snapshot();
          } else if (command.op === 'test') {
            if (this.state.sounding) throw new Error('busy');
            this.startBeep(); this.awaitRelease = true; this.addLog('test', 'sounded'); data = this.snapshot();
          } else if (command.op === 'stop') {
            this.stopBeep(); data = this.snapshot();
          } else if (command.op === 'clear') {
            this.entries = []; data = this.snapshot();
          } else if (command.op === 'logs') {
            const after = command.after == null ? 0 : command.after, limit = command.limit == null ? 5 : command.limit;
            if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 5) throw new Error('invalid_cursor');
            const entries = this.entries.filter(entry => entry.seq > after).slice(0, limit);
            const next = entries.length ? entries[entries.length - 1].seq : after;
            const info = this.logInfo(); data = { ...info, entries, next, hasMore: this.entries.some(entry => entry.seq > next), reset: after > 0 && (after < info.oldest - 1 || after > info.latest) };
          } else throw new Error('unknown_op');
          this.send({ id: command.id, session: command.session, ok: true, data });
        } catch (error) { this.send({ id: command.id, session: command.session, ok: false, error: error.message === 'busy' ? 'busy' : 'invalid_request', message: error.message }); }
      }
    }
    async disconnect() { this.closed = true; this.clearInterval(this.timer); }
  }
  return { SerialTransport, BluetoothTransport, DemoTransport };
});
