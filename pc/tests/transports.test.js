'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const P = require('../../miniprogram/utils/protocol');
const { DemoTransport, BluetoothTransport, SerialTransport } = require('../transports');

function simulator() {
  let now = 0, pulse;
  const messages = [], decoder = new P.LineDecoder();
  const device = new DemoTransport({ onBytes: bytes => messages.push(...decoder.push(bytes)), onDisconnect: () => {} }, {
    now: () => now, setInterval: callback => { pulse = callback; return 1; }, clearInterval: () => { pulse = null; }
  });
  function advance(ms) { const end = now + ms; while (now < end) { now = Math.min(end, now + 25); if (pulse) pulse(); } }
  async function request(op, fields = {}) {
    const id = messages.length + 1, session = '0123456789abcdef';
    await device.write(P.encodeFrame({ id, session, op, ...fields }));
    const reply = messages.findLast(value => value.id === id);
    assert.equal(reply.session, session);
    return reply;
  }
  return { device, messages, advance, request };
}
test('demo uses the real wire protocol; held activity cannot repeat or extend a beep', async () => {
  const s = simulator(); await s.device.connect();
  assert.equal((await s.request('get')).data.version, '1.0.0-demo');
  await s.request('set', { config: { beepMs: 300, cooldownMs: 100, confirmMs: 50, releaseMs: 50 } });
  s.device.simulateActivity(2000); s.advance(100);
  assert.equal(s.device.state.sounding, true); assert.equal(s.device.state.triggerCount, 1);
  s.advance(300); assert.equal(s.device.state.sounding, false);
  s.advance(1500); assert.equal(s.device.state.triggerCount, 1);
  s.advance(200); s.device.simulateActivity(200); s.advance(100);
  assert.equal(s.device.state.triggerCount, 2);
  await s.device.disconnect();
});
test('manual tests are distinct; muted/disarmed events still log; sequence survives clear', async () => {
  const s = simulator(); await s.device.connect();
  await s.request('set', { config: { muted: true, beepMs: 100, cooldownMs: 0, confirmMs: 20, releaseMs: 50 } });
  s.device.simulateActivity(100); s.advance(100);
  assert.equal(s.device.entries[0].result, 'muted'); assert.equal(s.device.state.triggerCount, 1);
  s.advance(100); await s.request('test');
  assert.equal(s.device.state.sounding, true); assert.equal(s.device.entries[1].type, 'test');
  assert.equal(s.device.state.triggerCount, 1);
  assert.equal((await s.request('test')).ok, false);
  const stopped = await s.request('stop'); assert.equal(s.device.state.sounding, false);
  assert.notEqual(stopped.data.state.phase, 'sounding');
  const previous = s.device.sequence; await s.request('clear'); assert.equal(s.device.sequence, previous);
  assert.equal((await s.request('logs', { after: previous, limit: 5 })).data.entries.length, 0);
  await s.device.disconnect();
});
test('demo config errors do not mutate settings; time is unknown until synchronized', async () => {
  const s = simulator(); await s.device.connect();
  const before = { ...s.device.config };
  const rejected = await s.request('set', { config: { beepMs: 3 } });
  assert.equal(rejected.ok, false); assert.deepEqual(s.device.config, before);
  await s.request('test'); assert.equal(s.device.entries[0].epochMs, 0);
  await s.request('stop'); await s.request('time', { epochMs: 1794000000000 });
  await s.request('test'); assert.equal(s.device.entries[1].epochMs, 1794000000000);
  await s.device.disconnect();
});
test('demo and RpcClient integrate without bypassing command acknowledgement', async () => {
  let rpc;
  const device = new DemoTransport({ onBytes: bytes => rpc.receive(bytes), onDisconnect: () => {} });
  rpc = new P.RpcClient({ write: bytes => device.write(bytes) });
  await device.connect();
  const snapshot = await rpc.request('get'); assert.match(snapshot.deviceId, /^DEMO-/);
  assert.equal((await rpc.request('set', { config: { armed: false } })).config.armed, false);
  await assert.rejects(rpc.request('set', { config: { unknown: 1 } }));
  rpc.close(new Error('done')); await device.disconnect();
});
test('BLE writes serial chunks no longer than 20 bytes and unregisters listeners', async () => {
  const calls = [], removed = [];
  const transport = new BluetoothTransport({ onBytes: () => {}, onDisconnect: () => {} });
  transport.rx = { writeValueWithResponse: async bytes => { calls.push([...bytes]); } };
  transport.tx = { removeEventListener: (...args) => removed.push(args) };
  transport.device = { removeEventListener: (...args) => removed.push(args), gatt: { connected: true, disconnect: () => calls.push('disconnect') } };
  const bytes = Uint8Array.from({ length: 51 }, (_, index) => index);
  await transport.write(bytes);
  assert.deepEqual(calls.map(value => value.length), [20, 20, 11]);
  assert.deepEqual(calls.flat(), [...bytes]);
  await transport.disconnect(); assert.equal(removed.length, 2);
  await assert.rejects(transport.write(bytes));
});
test('serial close cancels reads, releases locks and closes the actual port', async () => {
  const calls = [];
  const transport = new SerialTransport({ onBytes: () => {}, onDisconnect: () => {} });
  transport.reader = { cancel: async () => calls.push('cancel') };
  transport.writer = { write: async bytes => calls.push(bytes.length), releaseLock: () => calls.push('release') };
  transport.port = { close: async () => calls.push('close') };
  await transport.write(new Uint8Array(3)); await transport.disconnect();
  assert.deepEqual(calls, [3, 'cancel', 'release', 'close']);
  await assert.rejects(transport.write(new Uint8Array(1)));
});

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function withNavigator(value, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true });
  try { await run(); } finally { if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor); else delete globalThis.navigator; }
}
test('serial cancellation before device selection never opens the selected port', async () => {
  const selected = deferred(); let opens = 0;
  const port = { open: async () => { opens++; }, close: async () => {} };
  await withNavigator({ serial: { requestPort: () => selected.promise } }, async () => {
    const transport = new SerialTransport({ onBytes: () => {}, onDisconnect: () => {} });
    const rejected = assert.rejects(transport.connect(), /取消/);
    await transport.disconnect(); selected.resolve(port); await rejected;
    assert.equal(opens, 0);
  });
});
test('serial cancellation during open closes once after open resolves and never acquires locks', async () => {
  const opening = deferred(); let closes = 0, acquired = false, started = false;
  const port = { open: () => { started = true; return opening.promise; }, close: async () => { closes++; }, writable: { getWriter: () => { acquired = true; } } };
  await withNavigator({ serial: { requestPort: async () => port } }, async () => {
    const transport = new SerialTransport({ onBytes: () => {}, onDisconnect: () => {} });
    const rejected = assert.rejects(transport.connect(), /取消/);
    await Promise.resolve(); assert.equal(started, true);
    const closing = transport.disconnect(); opening.resolve();
    await Promise.all([rejected, closing]);
    assert.equal(closes, 1); assert.equal(acquired, false);
  });
});
test('BLE cancellation during GATT connect tears down the late connection', async () => {
  const connecting = deferred(); let connects = 0, disconnects = 0, services = 0;
  const gatt = { connected: false, connect: () => { connects++; return connecting.promise; }, disconnect: () => { disconnects++; gatt.connected = false; }, getPrimaryService: async () => { services++; } };
  const device = { gatt, addEventListener: () => {}, removeEventListener: () => {} };
  await withNavigator({ bluetooth: { requestDevice: async () => device } }, async () => {
    const transport = new BluetoothTransport({ onBytes: () => {}, onDisconnect: () => {} });
    const rejected = assert.rejects(transport.connect(), /取消/);
    await Promise.resolve(); assert.equal(connects, 1);
    await transport.disconnect(); gatt.connected = true; connecting.resolve(gatt);
    await rejected; assert.equal(gatt.connected, false); assert.equal(disconnects, 1); assert.equal(services, 0);
  });
});
test('demo invokes browser timer methods with the global receiver', async () => {
  const originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval;
  let cleared = false;
  globalThis.setInterval = function (callback, delay) { assert.equal(this, globalThis); assert.equal(delay, 25); return 42; };
  globalThis.clearInterval = function (handle) { assert.equal(this, globalThis); assert.equal(handle, 42); cleared = true; };
  try {
    const device = new DemoTransport({ onBytes: () => {}, onDisconnect: () => {} });
    await device.connect(); await device.disconnect(); assert.equal(cleared, true);
  } finally { globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear; }
});
test('sound presets round-trip over the real RPC protocol and tests preserve motion counts', async () => {
  let rpc;
  const device = new DemoTransport({ onBytes: bytes => rpc.receive(bytes), onDisconnect: () => {} });
  rpc = new P.RpcClient({ write: bytes => device.write(bytes) });
  await device.connect();
  try {
    assert.equal((await rpc.request('get')).config.sound, 'single');
    for (const sound of ['single', 'double', 'chime', 'siren']) {
      const saved = await rpc.request('set', { config: { sound } });
      assert.equal(saved.config.sound, sound);
      const tested = await rpc.request('test');
      assert.equal(tested.config.sound, sound);
      assert.equal(tested.state.sounding, true);
      assert.equal(tested.state.triggerCount, 0);
      assert.equal(device.entries[device.entries.length - 1].type, 'test');
      await rpc.request('stop');
    }
    await assert.rejects(rpc.request('set', { config: { sound: 'speech' } }));
    assert.equal((await rpc.request('get')).config.sound, 'siren');
  } finally { rpc.close(new Error('done')); await device.disconnect(); }
});
test('late ACK from a previous RPC session cannot satisfy a new same-id request', async () => {
  const decoder = new P.LineDecoder(); let oldCommand;
  const oldRpc = new P.RpcClient({ write: async bytes => { oldCommand = decoder.push(bytes)[0]; } });
  const oldRequest = oldRpc.request('get');
  const closed = assert.rejects(oldRequest, /old session closed/);
  await Promise.resolve();
  assert.match(oldCommand.session, /^[0-9a-fA-F]{16}$/);
  oldRpc.close(new Error('old session closed')); await closed;

  let rpc, reply, settled = false;
  const responses = new P.LineDecoder();
  const device = new DemoTransport({ onBytes: bytes => {
    for (const message of responses.push(bytes)) if (message.id) reply = message;
  }, onDisconnect: () => {} });
  rpc = new P.RpcClient({ write: bytes => device.write(bytes) });
  await device.connect();
  try {
    const request = rpc.request('get').then(value => { settled = true; return value; });
    await Promise.resolve(); await Promise.resolve();
    assert.ok(reply); assert.equal(reply.id, oldCommand.id);
    assert.notEqual(reply.session, oldCommand.session);
    rpc.receive(P.encodeFrame({ ...reply, session: oldCommand.session, data: { deviceId: 'STALE' } }));
    await Promise.resolve(); await Promise.resolve();
    assert.equal(settled, false);
    rpc.receive(P.encodeFrame(reply));
    assert.match((await request).deviceId, /^DEMO-/);
  } finally { rpc.close(new Error('done')); await device.disconnect(); }
});
