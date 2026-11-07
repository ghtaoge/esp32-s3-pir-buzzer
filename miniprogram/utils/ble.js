const protocol = require('./protocol');

const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function validateSnapshot(snapshot, expectedDeviceId) {
  if (!snapshot || typeof snapshot.deviceId !== 'string' || !snapshot.deviceId || snapshot.deviceId.length > 64 ||
    (expectedDeviceId && snapshot.deviceId !== expectedDeviceId) || !/^1\./.test(String(snapshot.version)) ||
    !snapshot.config || typeof snapshot.config !== 'object' || !snapshot.state || typeof snapshot.state !== 'object' ||
    typeof snapshot.bootId !== 'string' || !snapshot.bootId || snapshot.bootId.length > 64 ||
    typeof snapshot.state.phase !== 'string' || typeof snapshot.state.sounding !== 'boolean' ||
    typeof snapshot.state.timeKnown !== 'boolean' || !Number.isSafeInteger(snapshot.state.triggerCount) || snapshot.state.triggerCount < 0 ||
    !snapshot.logs || !['oldest', 'latest', 'count', 'capacity'].every(key => Number.isSafeInteger(snapshot.logs[key]) && snapshot.logs[key] >= 0) ||
    snapshot.logs.capacity < 1 || snapshot.logs.capacity > 1000 || snapshot.logs.count > snapshot.logs.capacity) throw new Error('设备返回的协议版本或状态不兼容');
  const hardware = snapshot.hardware;
  if (snapshot.config.sensor !== 'pir' || !hardware || hardware.sensorModel !== 'HC-SR505' ||
    hardware.pirPin !== 13 || hardware.buzzerPin !== 7 || hardware.radarSupported !== false) {
    throw new Error('硬件配置不匹配，请烧录 HC-SR505 专用固件 1.0.2 或更新版本（OUT GPIO13，蜂鸣器 GPIO7）');
  }
  const known = {};
  const legacyFields = ['radarMaxGate', 'radarMotionThreshold', 'radarStillThreshold'];
  // Legacy readback fields are optional. They are neither required from the
  // HC-only firmware nor included in a new configuration patch.
  Object.keys(protocol.DEFAULT_CONFIG).filter(key => !legacyFields.includes(key)).forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(snapshot.config, key)) throw new Error('设备参数不完整，请更新固件');
    known[key] = snapshot.config[key];
  });
  protocol.validateConfig(known);
  return snapshot;
}

function message(error) {
  const code = error && (error.errCode !== undefined ? error.errCode : error.errno);
  const raw = (error && (error.errMsg || error.message)) || '';
  let text = raw || '操作失败，请稍后重试';
  if (/not declared|未.*声明.*隐私/i.test(raw)) text = '当前 AppID 的隐私保护指引未声明蓝牙用途，请在微信后台补充声明后重新预览';
  else if (/privacy|隐私/i.test(raw)) text = '蓝牙隐私授权未完成，请同意隐私指引，并检查当前 AppID 的后台配置';
  else if (code === 10001) text = '手机蓝牙不可用，请打开蓝牙并检查系统权限';
  else if (code === 10003) text = '连接失败，请靠近开发板，确认设备没有被其他手机占用';
  else if (code === 10006) text = '设备已断开，请重新连接';
  else if (code === 10009) text = '当前系统不支持低功耗蓝牙';
  else if (code === 10016 || /location/i.test(raw)) text = '蓝牙扫描所需定位权限或定位服务不可用，请检查手机系统设置';
  else if (/auth|permission/i.test(raw)) text = '蓝牙授权未通过，请检查微信及手机系统的蓝牙权限';
  else if (/timeout|timed out|超时/i.test(raw) || code === 10008 || code === 10012) text = '设备响应超时，操作结果可能未确认。请重新连接并读取状态后再决定是否重做';
  const api = error && error.api;
  return text + (api ? `（${api}${code !== undefined ? ' / ' + code : ''}）` : '');
}

class SentinelClient {
  constructor(options = {}) {
    this.wx = options.wx || wx;
    this.events = options.events || {};
    this.apiTimeoutMs = options.apiTimeoutMs || 5000;
    this.requestTimeoutMs = options.requestTimeoutMs || 8000;
    this.frameDelayMs = options.frameDelayMs === undefined ? 5 : options.frameDelayMs;
    this.notifySettleMs = options.notifySettleMs === undefined ? 150 : options.notifySettleMs;
    this.session = null;
    this.ready = false;
    this.scanning = false;
    this.disposed = false;
    this.nearby = new Map();
    this.scanGeneration = 0;
    this.found = event => { if (this.scanning) this.acceptDevices(event.devices || []); };
    this.value = event => this.onValue(event);
    this.connection = event => {
      const session = this.session;
      if (session && event.deviceId === session.device.deviceId && !event.connected) {
        this.releaseSession(session, new Error('设备已断开，请重新连接'));
      }
    };
    this.registered = [];
    [['onBluetoothDeviceFound', 'offBluetoothDeviceFound', this.found],
      ['onBLECharacteristicValueChange', 'offBLECharacteristicValueChange', this.value],
      ['onBLEConnectionStateChange', 'offBLEConnectionStateChange', this.connection]]
      .forEach(([on, off, callback]) => {
        if (typeof this.wx[on] === 'function') { this.wx[on](callback); this.registered.push([off, callback]); }
      });
  }
  emit(name, ...args) {
    if (!this.disposed && typeof this.events[name] === 'function') this.events[name](...args);
  }
  call(name, args = {}, timeoutMs = this.apiTimeoutMs) {
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) reject(Object.assign(new Error(error.errMsg || error.message || name + '失败'), error, { api: name }));
        else resolve(value || {});
      };
      const timer = setTimeout(() => finish({ errMsg: name + ': timeout' }), timeoutMs);
      if (typeof this.wx[name] !== 'function') return finish({ errMsg: '当前微信不支持 ' + name + '，请升级微信后真机重试' });
      try { this.wx[name](Object.assign({}, args, { success: value => finish(null, value), fail: error => finish(error) })); }
      catch (error) { finish(error); }
    });
  }
  ensure(session) {
    if (this.disposed || this.session !== session || !session.active) throw new Error('连接已结束，请重新连接');
  }
  acceptDevices(devices) {
    devices.forEach(incoming => {
      if (!incoming.deviceId) return;
      const old = this.nearby.get(incoming.deviceId) || {};
      const device = Object.assign({}, old, incoming, {
        name: incoming.name || old.name || '', localName: incoming.localName || old.localName || '',
        advertisServiceUUIDs: incoming.advertisServiceUUIDs && incoming.advertisServiceUUIDs.length ? incoming.advertisServiceUUIDs : old.advertisServiceUUIDs || []
      });
      const names = [device.localName, device.name];
      const matchingName = names.find(name => name.startsWith('S3-Sentinel-'));
      device.compatible = !!matchingName || device.advertisServiceUUIDs.some(uuid => same(uuid, protocol.UUIDS.service));
      device.name = matchingName || device.localName || device.name || '未命名感应器';
      this.nearby.set(device.deviceId, device);
      while (this.nearby.size > 100) this.nearby.delete(this.nearby.keys().next().value);
    });
    const found = Array.from(this.nearby.values()).filter(device => device.compatible)
      .sort((a, b) => (b.RSSI || -999) - (a.RSSI || -999)).slice(0, 30)
      .map(device => ({ deviceId: device.deviceId, name: device.name, RSSI: device.RSSI }));
    this.emit('onDevices', found, this.nearby.size);
  }
  async scan(durationMs = 12000) {
    if (this.disposed) throw new Error('页面已关闭');
    if (this.scanStarting) throw new Error('蓝牙搜索仍在启动或清理，请稍后重试');
    this.scanStarting = true;
    try {
    await this.stopScan(true);
    const generation = ++this.scanGeneration;
    this.emit('onScanProgress', '正在开启蓝牙，请留意系统授权提示');
    if (typeof this.wx.requirePrivacyAuthorize === 'function') await this.call('requirePrivacyAuthorize');
    await this.call('openBluetoothAdapter', { mode: 'central' });
    if (this.disposed || generation !== this.scanGeneration) return;
    this.nearby.clear();
    this.emit('onDevices', [], 0);
    this.scanning = true;
    this.emit('onScanProgress', '正在搜索 S3-Sentinel，请保持开发板供电');
    try {
      // 不按服务过滤，兼容第一次广播没有完整服务列表的手机。
      await this.call('startBluetoothDevicesDiscovery', { allowDuplicatesKey: true });
      if (this.disposed || generation !== this.scanGeneration) {
        // A start callback can arrive after cancellation. Always stop that
        // just-started native discovery even if our local flag is already off.
        this.scanning = false;
        await this.call('stopBluetoothDevicesDiscovery').catch(() => {});
        return;
      }
      this.scanTimer = setTimeout(() => this.stopScan(false).catch(() => {}), durationMs);
      try {
        const cached = await this.call('getBluetoothDevices');
        if (this.scanning && generation === this.scanGeneration) this.acceptDevices(cached.devices || []);
      } catch (_) { /* 实时发现仍继续。 */ }
    } catch (error) {
      await this.stopScan(true);
      throw error;
    }
    } finally { this.scanStarting = false; }
  }
  async stopScan(silent = false) {
    ++this.scanGeneration;
    clearTimeout(this.scanTimer);
    this.scanTimer = null;
    const wasScanning = this.scanning;
    this.scanning = false;
    if (wasScanning) await this.call('stopBluetoothDevicesDiscovery').catch(() => {});
    if (!silent) this.emit('onScanEnd', { seen: this.nearby.size, matched: Array.from(this.nearby.values()).filter(device => device.compatible).length });
  }
  ids(session, characteristicId) {
    return { deviceId: session.device.deviceId, serviceId: session.serviceId, characteristicId };
  }
  async write(session, bytes) {
    for (const chunk of protocol.chunkBytes(bytes, 20)) {
      this.ensure(session);
      // .slice() owns the exact 20-byte chunk rather than a larger backing buffer.
      const value = chunk.slice().buffer;
      await this.call('writeBLECharacteristicValue', Object.assign(this.ids(session, session.rxId), { value, writeType: 'write' }));
      this.ensure(session);
      if (this.frameDelayMs) await delay(this.frameDelayMs);
    }
  }
  async connect(device) {
    if (!device || !device.deviceId) throw new Error('请选择一个设备');
    await this.stopScan(true);
    await this.disconnect();
    if (this.disposed) throw new Error('页面已关闭');
    const session = { device, active: true, rpc: null };
    this.session = session;
    try {
      await this.call('createBLEConnection', { deviceId: device.deviceId, timeout: 10000 }, 11000);
      this.ensure(session);
      const serviceResult = await this.call('getBLEDeviceServices', { deviceId: device.deviceId });
      this.ensure(session);
      const service = (serviceResult.services || []).find(item => same(item.uuid, protocol.UUIDS.service));
      if (!service) throw new Error('未找到感应器服务，请确认烧录的是本项目固件');
      session.serviceId = service.uuid;
      const characteristicResult = await this.call('getBLEDeviceCharacteristics', { deviceId: device.deviceId, serviceId: session.serviceId });
      this.ensure(session);
      const characteristics = characteristicResult.characteristics || [];
      const rx = characteristics.find(item => same(item.uuid, protocol.UUIDS.rx) && item.properties && item.properties.write);
      const tx = characteristics.find(item => same(item.uuid, protocol.UUIDS.tx) && item.properties && item.properties.notify);
      if (!rx || !tx) throw new Error('蓝牙特征不完整，需要 write-with-response 和 notify，请更新固件');
      session.rxId = rx.uuid; session.txId = tx.uuid;
      session.rpc = new protocol.RpcClient({
        timeoutMs: this.requestTimeoutMs, maxQueue: 16,
        write: bytes => this.write(session, bytes),
        onEvent: (event, data) => {
          if (this.session !== session || !session.active) return;
          if (event === 'state') this.emit('onState', data);
          else if (event === 'log') this.emit('onLog', data);
        },
        onFatal: error => {
          if (this.session === session) {
            this.releaseSession(session, error);
            this.call('closeBLEConnection', { deviceId: device.deviceId }).catch(() => {});
          }
        }
      });
      await this.call('notifyBLECharacteristicValueChange', Object.assign(this.ids(session, tx.uuid), { state: true }));
      this.ensure(session);
      if (this.notifySettleMs) await delay(this.notifySettleMs);
      this.ensure(session);
      const initial = validateSnapshot(await session.rpc.request('get'));
      session.stableDeviceId = initial.deviceId;
      const snapshot = validateSnapshot(await session.rpc.request('time', { epochMs: Date.now() }), initial.deviceId);
      this.ensure(session);
      this.ready = true;
      this.emit('onConnection', true, device);
      return snapshot;
    } catch (error) {
      if (this.session === session) this.releaseSession(session, error);
      await this.call('closeBLEConnection', { deviceId: device.deviceId }).catch(() => {});
      throw error;
    }
  }
  onValue(event) {
    const session = this.session;
    if (!session || !session.active || !session.rpc || event.deviceId !== session.device.deviceId ||
      (event.serviceId && !same(event.serviceId, session.serviceId)) || !same(event.characteristicId, session.txId)) return;
    try { session.rpc.receive(event.value instanceof Uint8Array ? event.value : new Uint8Array(event.value)); }
    catch (error) { this.releaseSession(session, error); this.call('closeBLEConnection', { deviceId: session.device.deviceId }).catch(() => {}); }
  }
  request(op, fields = {}) {
    const session = this.session;
    if (!this.ready || !session || !session.active || !session.rpc) return Promise.reject(new Error('请先连接感应器'));
    if (op === 'set') {
      try { protocol.validateConfig(fields.config); }
      catch (error) { return Promise.reject(error); }
    }
    return session.rpc.request(op, fields).then(data => {
      if (['get', 'set', 'time', 'test', 'stop', 'clear'].includes(op)) {
        try { return validateSnapshot(data, session.stableDeviceId); }
        catch (error) {
          this.releaseSession(session, error);
          this.call('closeBLEConnection', { deviceId: session.device.deviceId }).catch(() => {});
          throw error;
        }
      }
      return data;
    });
  }
  releaseSession(session, reason) {
    if (this.session !== session) return;
    session.active = false;
    this.session = null;
    this.ready = false;
    if (session.rpc) session.rpc.close(reason || new Error('连接已关闭'));
    this.emit('onConnection', false, session.device, reason);
  }
  async disconnect() {
    const session = this.session;
    if (!session) return;
    this.releaseSession(session, new Error('连接已关闭'));
    await this.call('closeBLEConnection', { deviceId: session.device.deviceId }).catch(() => {});
  }
  async destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.registered.forEach(([name, callback]) => { if (typeof this.wx[name] === 'function') this.wx[name](callback); });
    this.registered = [];
    await this.stopScan(true);
    await this.disconnect();
    await this.call('closeBluetoothAdapter').catch(() => {});
  }
}

module.exports = { SentinelClient, message, validateSnapshot };
