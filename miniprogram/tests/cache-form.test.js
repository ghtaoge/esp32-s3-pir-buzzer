const test = require('node:test');
const assert = require('node:assert/strict');
const { LogCache, displayEntry, timeLabel } = require('../utils/cache');
const protocol = require('../utils/protocol');
const { toDraft, makePatch } = require('../utils/form');

function storage() {
  const values = new Map();
  return { getStorageSync: key => values.get(key), setStorageSync: (key, value) => values.set(key, structuredClone(value)) };
}
function entry(seq, extra = {}) { return { seq, bootId: 'boot-id-a', uptimeMs: seq * 1000, epochMs: 0, type: 'motion', result: 'sounded', distanceCm: 0, energy: 0, ...extra }; }
function page(entries, next, more = false, extra = {}) { return { entries, next, hasMore: more, reset: false, oldest: 1, latest: next, count: entries.length, ...extra }; }

test('cache isolates stable device IDs, deduplicates notifications, and only ACK pages advance cursor', () => {
  const store = storage(), a = new LogCache('chip-a', store), b = new LogCache('chip-b', store);
  a.merge([entry(8), entry(8), entry(3)]);
  assert.equal(a.cursor, 0); assert.equal(a.entries.length, 2);
  a.applyPage(page([entry(1), entry(2), entry(3)], 3, true));
  assert.equal(a.cursor, 3); assert.deepEqual(a.entries.map(item => item.seq), [1, 2, 3, 8]);
  a.flush(); b.flush();
  const reopened = new LogCache('chip-a', store);
  assert.equal(reopened.cursor, 3); assert.equal(reopened.entries.length, 4);
  assert.equal(new LogCache('chip-b', store).entries.length, 0);
});

test('cache and UI list stay bounded with overwrite gap and explicit clear keeping sequence cursor', () => {
  const cache = new LogCache('chip', storage());
  cache.merge(Array.from({ length: 1400 }, (_, index) => entry(index + 1)));
  assert.equal(cache.entries.length, 1000); assert.equal(cache.visible().length, 100);
  cache.applyPage(page([entry(1401), entry(1402)], 1402, false, { reset: true, oldest: 1200 }));
  assert.equal(cache.gap, true); assert.equal(cache.entries[0].seq, 1200);
  cache.clear(1402); assert.equal(cache.entries.length, 0); assert.equal(cache.cursor, 1402);
  cache.merge([entry(1403)]); assert.equal(cache.cursor, 1402); cache.flush();
});

test('invalid pages do not advance cursor or partially merge', () => {
  const cache = new LogCache('chip', storage());
  assert.throws(() => cache.applyPage(page([entry(2), entry(1)], 1)), /顺序/);
  assert.equal(cache.cursor, 0); assert.equal(cache.entries.length, 0);
  assert.throws(() => cache.applyPage(page([], 0, true)), /没有进展/);
  assert.throws(() => cache.applyPage(page([entry(1)], 2)), /游标不匹配/);
  assert.throws(() => cache.applyPage(page([], 100)), /不能跳过游标/);
  assert.throws(() => cache.applyPage(page([entry(1, { result: 'invented' })], 1)), /无效/);
  assert.throws(() => cache.applyPage(page([entry(1, { bootId: 'x'.repeat(65) })], 1)), /无效/);
  cache.flush();
});

test('uncalibrated log time remains boot-relative and manual tests are distinguished', () => {
  assert.match(timeLabel(entry(1)), /启动.*未校时/);
  assert.equal(timeLabel(entry(1, { epochMs: Date.UTC(2026, 10, 7, 0, 0, 0) })), '2026-11-07 08:00:00');
  const testLog = displayEntry(entry(2, { type: 'test' }));
  assert.equal(testLog.label, '手动测试'); assert.match(testLog.detail, /不计入/);
});

test('strict form rejects fractions and out-of-range values, omits unavailable radar fields', () => {
  const current = {...protocol.DEFAULT_CONFIG}, draft = toDraft(current);
  draft.beepMs = '100.5'; assert.throws(() => makePatch(draft, current), /整数/);
  draft.beepMs = '99'; assert.throws(() => makePatch(draft, current));
  draft.beepMs = '3000'; draft.radarMotionThreshold = 'not applicable';
  assert.deepEqual(makePatch(draft, current), {});
  draft.sensor = 'radar'; assert.throws(() => makePatch(draft, current), /整数/);
  draft.radarMotionThreshold = '25'; draft.radarStillThreshold = '40';
  assert.deepEqual(makePatch(draft, current), { sensor: 'radar', radarMotionThreshold: 25, radarStillThreshold: 40 });
});

test('sound presets preserve defaults and strictly validate enum before creating a diff patch', () => {
  const current = {...protocol.DEFAULT_CONFIG};
  assert.equal(current.sound, 'single');
  const draft = toDraft(current);
  assert.equal(draft.sound, 'single'); assert.deepEqual(makePatch(draft, current), {});
  for (const sound of ['double', 'chime', 'siren']) {
    draft.sound = sound;
    assert.deepEqual(makePatch(draft, current), { sound });
  }
  for (const sound of ['music', 'SIREN', '', null, 1, true]) {
    draft.sound = sound; assert.throws(() => makePatch(draft, current), /声音预设/);
  }
  draft.sound = 'double'; draft.buzzerMode = 'active';
  assert.deepEqual(makePatch(draft, current), { buzzerMode: 'active', sound: 'double' });
});
