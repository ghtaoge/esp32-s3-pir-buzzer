const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../utils/protocol');
const { SentinelClient, message, validateSnapshot } = require('../utils/ble');

function mockWx() {
  const listeners = { found: new Set(), value: new Set(), connection: new Set() };
  const commands = [], writes = [], held = [];
  let activeWrites = 0, maxActiveWrites = 0;
  const snapshot = { deviceId: 'chip-a', version: '1.0.2', bootId: 'boot-a', hardware: { sensorModel: 'HC-SR505', pirPin: 13, buzzerPin: 7, radarSupported: false }, config: {...protocol.DEFAULT_CONFIG}, state: { phase: 'ready', triggerCount: 0, sounding: false, timeKnown: true }, logs: { oldest: 0, latest: 0, count: 0, capacity: 1000 } };
  const mock = { listeners, commands, writes, held, snapshot, suppress: new Set(), holdWrites: false, stopCount: 0 };
  const decoder = new protocol.LineDecoder();
  function reply(message) {
    const bytes = protocol.encodeFrame(message);
    // 3-byte fragments deliberately split Chinese UTF-8 and JSON fields.
    protocol.chunkBytes(bytes, 3).forEach(chunk => listeners.value.forEach(callback => callback({ deviceId: 'ble-a', serviceId: protocol.UUIDS.service.toUpperCase(), characteristicId: protocol.UUIDS.tx.toUpperCase(), value: chunk.buffer })));
  }
  const ok = args => queueMicrotask(() => args.success({}));
  const api = {
    onBluetoothDeviceFound: callback => listeners.found.add(callback), offBluetoothDeviceFound: callback => listeners.found.delete(callback),
    onBLECharacteristicValueChange: callback => listeners.value.add(callback), offBLECharacteristicValueChange: callback => listeners.value.delete(callback),
    onBLEConnectionStateChange: callback => listeners.connection.add(callback), offBLEConnectionStateChange: callback => listeners.connection.delete(callback),
    openBluetoothAdapter: ok, requirePrivacyAuthorize: ok, closeBluetoothAdapter: ok,
    startBluetoothDevicesDiscovery: ok,
    stopBluetoothDevicesDiscovery(args) { mock.stopCount++; ok(args); },
    getBluetoothDevices: args => args.success({ devices: [] }),
    createBLEConnection: ok, closeBLEConnection: ok,
    getBLEDeviceServices: args => args.success({ services: [{ uuid: protocol.UUIDS.service.toUpperCase() }] }),
    getBLEDeviceCharacteristics: args => args.success({ characteristics: [
      { uuid: protocol.UUIDS.rx, properties: { write: true } }, { uuid: protocol.UUIDS.tx, properties: { notify: true } }
    ] }),
    notifyBLECharacteristicValueChange: ok,
    writeBLECharacteristicValue(args) {
      activeWrites++; maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      const bytes = new Uint8Array(args.value); writes.push(bytes);
      const complete = () => {
        activeWrites--; args.success({});
        decoder.push(bytes).forEach(command => {
          commands.push(command);
          if (mock.onCommand) mock.onCommand(command, snapshot);
          if (mock.suppress.has(command.op)) return;
          if (command.op === 'set') snapshot.config = protocol.validateConfig(command.config, snapshot.config);
          reply({ event: 'state', data: { phase: 'ready', label: '活动状态' } });
          reply({ id: command.id, session: command.session, ok: true, data: snapshot });
        });
      };
      if (mock.holdWrites) held.push(complete); else queueMicrotask(complete);
    }
  };
  mock.api = api; mock.reply = reply;
  mock.disconnect = () => listeners.connection.forEach(callback => callback({ deviceId: 'ble-a', connected: false }));
  mock.maxActiveWrites = () => maxActiveWrites;
  return mock;
}
function client(mock, events = {}, extra = {}) {
  return new SentinelClient({ wx: mock.api, events, notifySettleMs: 0, frameDelayMs: 0, apiTimeoutMs: 100, requestTimeoutMs: 150, ...extra });
}
const device = { deviceId: 'ble-a', name: 'S3-Sentinel-AABBCC' };

test('real BLE session discovers UUIDs, serializes 20-byte writes, reassembles notify fragments, and time-syncs', async () => {
  const mock = mockWx(), events = [];
  const connection = client(mock, { onState: value => events.push(value) });
  const first = await connection.connect(device);
  assert.equal(first.deviceId, 'chip-a');
  assert.deepEqual(mock.commands.slice(0, 2).map(command => command.op), ['get', 'time']);
  assert.ok(Number.isSafeInteger(mock.commands[1].epochMs));
  const results = await Promise.all([connection.request('set', { config: { beepMs: 700 } }), connection.request('get')]);
  assert.equal(results[0].config.beepMs, 700);
  assert.deepEqual(mock.commands.map(command => command.op), ['get', 'time', 'set', 'get']);
  assert.ok(mock.writes.every(bytes => bytes.length > 0 && bytes.length <= 20));
  assert.equal(mock.maxActiveWrites(), 1);
  assert.equal(events[0].label, '活动状态');
  assert.equal(mock.listeners.value.size, 1);
  await connection.disconnect();
  await connection.connect(device);
  assert.equal(mock.listeners.value.size, 1, 'reconnecting must not add another notification listener');
  await connection.destroy();
  assert.equal(mock.listeners.value.size + mock.listeners.found.size + mock.listeners.connection.size, 0);
});

test('disconnect cancels active and queued commands and prevents later chunks', async () => {
  const mock = mockWx(), connection = client(mock);
  await connection.connect(device);
  mock.holdWrites = true;
  const active = connection.request('set', { config: { beepMs: 4321, cooldownMs: 2000 } });
  const queued = connection.request('get');
  const checks = [assert.rejects(active, /断开/), assert.rejects(queued, /断开/)];
  await new Promise(resolve => setImmediate(resolve));
  const before = mock.writes.length;
  mock.disconnect();
  await Promise.all(checks);
  mock.held.splice(0).forEach(complete => complete());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(mock.writes.length, before, 'cannot continue writing a partial command into another session');
  assert.equal(connection.ready, false);
  await connection.destroy();
});

test('timeout closes session and never retries a mutating command', async () => {
  const mock = mockWx(), connection = client(mock, {}, { requestTimeoutMs: 30 });
  await connection.connect(device);
  mock.suppress.add('stop');
  await assert.rejects(connection.request('stop'), /timed out/);
  assert.equal(connection.ready, false);
  assert.equal(mock.commands.filter(command => command.op === 'stop').length, 1);
  await assert.rejects(connection.request('get'), /先连接/);
  await connection.destroy();
});

test('scan results stay bounded, merge name-less updates and release discovery timer/listeners', async () => {
  const mock = mockWx(); let devices = [];
  const connection = client(mock, { onDevices: found => { devices = found; } });
  await connection.scan(15);
  mock.listeners.found.forEach(callback => callback({ devices: [{ deviceId: 'same', name: 'S3-Sentinel-000001', RSSI: -40 }] }));
  mock.listeners.found.forEach(callback => callback({ devices: [{ deviceId: 'same', RSSI: -30 }] }));
  assert.equal(devices[0].name, 'S3-Sentinel-000001');
  mock.listeners.found.forEach(callback => callback({ devices: Array.from({ length: 150 }, (_, index) => ({ deviceId: 'id-' + index, localName: 'S3-Sentinel-' + index, RSSI: -index })) }));
  assert.ok(connection.nearby.size <= 100); assert.ok(devices.length <= 30);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(connection.scanning, false); assert.equal(connection.scanTimer, null); assert.equal(mock.stopCount, 1);
  await connection.destroy();
  assert.equal(mock.listeners.found.size, 0);
});

test('permission and privacy failures retain actionable platform context', () => {
  assert.match(message({ api: 'openBluetoothAdapter', errCode: 10001 }), /打开蓝牙/);
  assert.match(message({ api: 'startBluetoothDevicesDiscovery', errMsg: 'api scope is not declared in privacy' }), /隐私保护指引/);
});

test('HC-SR505 profile rejects old pins, another sensor and missing hardware metadata', () => {
  const good = mockWx().snapshot;
  assert.equal(validateSnapshot(good), good);
  const modern = { ...good, config: { ...good.config } };
  ['radarMaxGate', 'radarMotionThreshold', 'radarStillThreshold'].forEach(key => { delete modern.config[key]; });
  assert.equal(validateSnapshot(modern), modern, 'legacy radar readback fields are optional');
  assert.throws(() => validateSnapshot({ ...good, hardware: undefined }), /HC-SR505 专用固件/);
  assert.throws(() => validateSnapshot({ ...good, hardware: { ...good.hardware, pirPin: 3 } }), /GPIO13/);
  assert.throws(() => validateSnapshot({ ...good, config: { ...good.config, sensor: 'radar' } }), /硬件配置不匹配/);
  assert.throws(() => validateSnapshot({ ...good, hardware: { ...good.hardware, radarSupported: true } }), /硬件配置不匹配/);
});

test('cancelled discovery stops even when native start completes after cancellation', async () => {
  const mock = mockWx(), connection = client(mock);
  let completeStart;
  mock.api.startBluetoothDevicesDiscovery = args => { completeStart = args.success; };
  const scanning = connection.scan(1000);
  while (!completeStart) await new Promise(resolve => setImmediate(resolve));
  await connection.stopScan(true);
  completeStart({});
  await scanning;
  assert.equal(connection.scanning, false);
  assert.equal(connection.scanTimer, null);
  assert.equal(mock.stopCount, 2, 'late start must receive its own native stop');
  await connection.destroy();
});

test('post-time-sync snapshot must belong to same stable device ID', async () => {
  const mock = mockWx(), connection = client(mock);
  mock.onCommand = (command, snapshot) => { if (command.op === 'time') snapshot.deviceId = 'different-chip'; };
  await assert.rejects(connection.connect(device), /不兼容/);
  assert.equal(connection.ready, false);
  await connection.destroy();
});

test('an old-session ACK cannot confirm a new write after reconnect with the same request id', async () => {
  const mock = mockWx(), connection = client(mock);
  await connection.connect(device);
  await connection.request('set', { config: { beepMs: 500 } });
  const oldCommand = mock.commands.at(-1);
  assert.match(oldCommand.session, /^[a-f0-9]{16}$/i);
  await connection.disconnect();
  await connection.connect(device);
  mock.suppress.add('set');
  let confirmed = false;
  const pending = connection.request('set', { config: { beepMs: 800 } });
  pending.then(() => { confirmed = true; }, () => {});
  await new Promise(resolve => setImmediate(resolve));
  const current = mock.commands.at(-1);
  assert.equal(current.id, oldCommand.id, 'reconnect deliberately reuses the numeric request id');
  assert.notEqual(current.session, oldCommand.session);
  mock.reply({ id: current.id, session: oldCommand.session, ok: true, data: mock.snapshot });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(confirmed, false, 'a delayed ACK from the previous RPC session must be ignored');
  mock.reply({ id: current.id, session: current.session, ok: true, data: { ...mock.snapshot, config: { ...mock.snapshot.config, beepMs: 800 } } });
  const result = await pending;
  assert.equal(result.config.beepMs, 800);
  await connection.destroy();
});
