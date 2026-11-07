const test = require('node:test');
const assert = require('node:assert/strict');
const definition = require('../pages/index/index');
const protocol = require('../utils/protocol');
const { LogCache } = require('../utils/cache');

function snapshot(config = {}) {
  return { deviceId: 'chip-a', bootId: 'boot-a', version: '1.0.0', config: {...protocol.DEFAULT_CONFIG, ...config}, state: { phase: 'ready', sounding: false, triggerCount: 0, timeKnown: true }, logs: { oldest: 0, latest: 0, count: 0, capacity: 1000 } };
}
function fixture(request) {
  const toasts = [], storage = new Map(); let modal;
  global.wx = { showToast: args => toasts.push(args.title), showModal: args => { modal = args; }, getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, structuredClone(value)) };
  const instance = Object.assign({}, definition, { data: structuredClone(definition.data), _alive: true, _visible: true, _syncToken: 0, _pendingActions: 0, client: { request },
    setData(values) { Object.keys(values).forEach(key => {
      const parts = key.split('.'); let target = this.data;
      while (parts.length > 1) target = target[parts.shift()];
      target[parts[0]] = values[key];
    }); }
  });
  instance.data.connected = true;
  return { instance, toasts, modal: () => modal };
}
const entry = seq => ({ seq, bootId: 'boot-a', uptimeMs: seq * 1000, epochMs: 0, type: 'motion', result: 'muted', distanceCm: 0, energy: 0 });

test('save only succeeds after device ACK and retains draft on radar rejection', async () => {
  let resolve;
  const { instance, toasts } = fixture(() => new Promise(done => { resolve = done; }));
  instance.data.draft.beepMs = '800'; instance.data.dirty = true;
  const pending = instance.save();
  assert.equal(instance.data.actionBusy, true); assert.equal(toasts.length, 0); assert.equal(instance.data.config.beepMs, 3000);
  resolve(snapshot({ beepMs: 800 })); await pending;
  assert.deepEqual(toasts, ['设备已确认并保存']); assert.equal(instance.data.dirty, false); assert.equal(instance.data.config.beepMs, 800);
  instance.client.request = async () => { throw new Error('radar acknowledgement failed'); };
  instance.data.draft.sensor = 'radar'; instance.data.sensorIndex = 1; instance.data.dirty = true;
  await instance.save();
  assert.equal(toasts.length, 1); assert.equal(instance.data.config.sensor, 'pir'); assert.equal(instance.data.dirty, true);
  assert.match(instance.data.error, /acknowledgement failed/);
});

test('invalid numeric draft never reaches transport; switch is confirmed rather than optimistic', async () => {
  let sent = 0, resolve;
  const { instance } = fixture(() => { sent++; return new Promise(done => { resolve = done; }); });
  instance.data.draft.beepMs = '100.5'; instance.data.dirty = true;
  await instance.save(); assert.equal(sent, 0); assert.match(instance.data.error, /整数/);
  instance.data.armed = true;
  const changing = instance.changeArmed({ detail: { value: false } });
  assert.equal(instance.data.armed, true);
  resolve(snapshot({ armed: false })); await changing;
  assert.equal(instance.data.armed, false);
});

test('pagination uses confirmed cursor and cancellation cannot advance a late page', async () => {
  const afters = []; let resolveLast;
  const { instance } = fixture(async (op, args) => {
    assert.equal(op, 'logs'); afters.push(args.after);
    if (args.after === 0) return { entries: [entry(1), entry(2)], next: 2, hasMore: true, reset: false };
    return new Promise(resolve => { resolveLast = resolve; });
  });
  instance.cache = new LogCache('chip-a', wx);
  const syncing = instance.syncLogs();
  while (!resolveLast) await new Promise(resolve => setImmediate(resolve));
  instance.cancelSync();
  resolveLast({ entries: [entry(3)], next: 3, hasMore: false, reset: false });
  await syncing;
  assert.deepEqual(afters, [0, 2]); assert.equal(instance.cache.cursor, 2); assert.equal(instance.cache.entries.length, 2);
  instance.cache.flush();
});

test('clear requires confirmation and cache remains until successful clear ACK', async () => {
  let sent = 0, resolve;
  const { instance, modal } = fixture(() => { sent++; return new Promise(done => { resolve = done; }); });
  instance.cache = new LogCache('chip-a', wx); instance.cache.merge([entry(1)]); instance.cache.flush();
  instance.clearLogs(); assert.equal(sent, 0);
  await modal().success({ confirm: false }); assert.equal(sent, 0);
  instance.clearLogs(); const clearing = modal().success({ confirm: true });
  assert.equal(sent, 1); assert.equal(instance.cache.entries.length, 1);
  resolve({...snapshot(), logs: { latest: 1, count: 0, capacity: 1000, oldest: 0 }});
  await clearing; assert.equal(instance.cache.entries.length, 0); assert.equal(instance.cache.cursor, 1);
});

test('storage failure is surfaced and page never renders more than recent 100 logs', () => {
  const { instance } = fixture(async () => snapshot());
  instance._latestState = { phase: 'ready', storageReady: false, storageErrors: 2 };
  instance._renderState(); assert.match(instance.data.storageWarning, /存储异常/);
  instance.cache = new LogCache('chip-a', wx);
  instance.cache.merge(Array.from({ length: 1000 }, (_, index) => entry(index + 1)));
  instance.data.visibleLimit = 1000; instance._renderLogs();
  assert.equal(instance.data.logs.length, 100);
  instance.cache.flush();
});

test('sound preset waits for ACK and real device audition uses saved preset, not unsaved draft', async () => {
  let resolve; const sent = [];
  const { instance, toasts, modal } = fixture((op, fields) => {
    sent.push({ op, fields });
    return new Promise(done => { resolve = done; });
  });
  instance.soundChange({ detail: { value: '2' } });
  assert.equal(instance.data.draft.sound, 'chime');
  assert.equal(instance.data.config.sound, 'single');
  instance.test(); assert.match(modal().content, /单音/); assert.match(modal().content, /未保存/);
  await modal().success({ confirm: false }); assert.equal(sent.length, 0);
  const saving = instance.save();
  assert.deepEqual(sent[0], { op: 'set', fields: { config: { sound: 'chime' } } });
  assert.equal(toasts.length, 0); assert.equal(instance.data.savedSoundLabel, '单音');
  resolve(snapshot({ sound: 'chime' })); await saving;
  assert.equal(instance.data.savedSoundLabel, '叮咚'); assert.equal(instance.data.dirty, false);
  assert.deepEqual(toasts, ['设备已确认并保存']);
  instance.test(); assert.match(modal().content, /叮咚/);
  modal().success({ confirm: true });
  assert.deepEqual(sent[1], { op: 'test', fields: {} });
  resolve(snapshot({ sound: 'chime' }));
  await new Promise(done => setImmediate(done));
  assert.equal(instance.data.actionBusy, false);
});
