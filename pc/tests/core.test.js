'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LogStore, displayTime, csvCell, toCsv } = require('../core');
const entry = (seq, extra = {}) => ({ seq, bootId: 'boot-1', uptimeMs: seq * 1000, epochMs: 0, type: 'motion', result: 'sounded', distanceCm: 150, energy: 60, ...extra });
function memoryStorage() { const values = new Map(); return { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }; }

test('records are bounded, deduplicated and ordered; live entries do not skip a sync cursor', () => {
  const store = new LogStore('board-A', memoryStorage());
  store.merge(Array.from({ length: 1000 }, (_, index) => entry(index + 1)));
  store.merge([entry(999, { result: 'muted' }), entry(1001)]);
  assert.equal(store.entries.size, 1000);
  assert.equal(store.list()[0].seq, 1001);
  assert.equal(store.list(false)[0].seq, 2);
  assert.equal(store.entries.get(999).result, 'muted');
  assert.equal(store.cursor, 0);
  store.applyPage({ entries: [entry(2), entry(3)], next: 3, hasMore: true, reset: true, oldest: 2, count: 1000 }, 0);
  assert.equal(store.cursor, 3);
  assert.equal(store.entries.size, 1000);
});
test('cache is device-specific and keeps only confirmed sync cursor', () => {
  const storage = memoryStorage(), a = new LogStore('A', storage);
  a.applyPage({ entries: [entry(1), entry(2)], next: 2, hasMore: false }, 0);
  a.merge([entry(4)]); a.persist();
  const restored = new LogStore('A', storage), other = new LogStore('B', storage);
  assert.equal(restored.cursor, 2);
  assert.deepEqual(restored.list().map(value => value.seq), [4, 2, 1]);
  assert.equal(other.entries.size, 0);
  assert.equal(other.cursor, 0);
});
test('clear and overwritten history remove obsolete cache without resetting sequence', () => {
  const store = new LogStore('A', memoryStorage());
  store.merge([entry(1), entry(2), entry(3)]);
  store.applyPage({ entries: [entry(4)], next: 4, hasMore: false, reset: true, oldest: 4, count: 1 }, 2);
  assert.deepEqual(store.list().map(value => value.seq), [4]);
  store.clear(8); assert.equal(store.cursor, 8); assert.equal(store.entries.size, 0);
  store.applyPage({ entries: [entry(9)], next: 9, hasMore: false }, 8);
  assert.equal(store.list()[0].seq, 9);
});
test('bad cache and bad pages cannot produce an unbounded/looping sync', () => {
  const store = new LogStore('A', { getItem: () => '{bad json', setItem: () => { throw new Error('quota'); } });
  assert.equal(store.entries.size, 0); assert.equal(store.cacheAvailable, false);
  assert.throws(() => store.applyPage({ entries: [], next: 3, hasMore: true }, 3));
  assert.throws(() => store.applyPage({ entries: [entry(5), entry(4)], next: 4 }, 3));
  assert.throws(() => store.applyPage({ entries: [entry(4)], next: 5 }, 3));
  assert.throws(() => store.applyPage({ entries: [], next: 4, hasMore: false }, 3));
  store.merge([{ seq: 1 }, entry(-1), entry(2)]); assert.equal(store.entries.size, 1);
  assert.doesNotThrow(() => store.persist());
  const unavailable = new LogStore('private-mode', null);
  unavailable.merge([entry(1)]); unavailable.persist();
  assert.equal(unavailable.entries.size, 1); assert.equal(unavailable.cacheAvailable, false);
});
test('unknown wall time stays relative and CSV neutralizes spreadsheet formula payloads', () => {
  assert.match(displayTime(entry(2)), /开机后 2\.0 秒/);
  assert.match(displayTime(entry(1, { epochMs: Date.UTC(2026, 10, 7) })), /2026/);
  for (const value of ['=cmd()', '+SUM(1)', '-1+2', '@A1', '\t=1', '  =2']) assert.equal(csvCell(value).slice(0, 2), '"\'');
  assert.equal(csvCell('a"b'), '"a""b"');
  const csv = toCsv([entry(1, { bootId: '=HYPERLINK("x")' })]);
  assert.equal(csv[0], '\uFEFF'); assert.match(csv, /"'=HYPERLINK/);
});
test('bounded log operations remain practical at retention capacity', () => {
  const store = new LogStore('perf', null), rows = Array.from({ length: 1000 }, (_, index) => entry(index + 1));
  const started = performance.now();
  for (let repeat = 0; repeat < 100; repeat++) { store.merge(rows); store.list(); }
  const elapsedMs = performance.now() - started;
  assert.equal(store.entries.size, 1000);
  assert.ok(elapsedMs < 3000, `100 × 1000-record merge/sort took ${elapsedMs.toFixed(1)} ms`);
  console.log(`PC log benchmark: 100 × 1000-record merge/sort = ${elapsedMs.toFixed(1)} ms`);
});
