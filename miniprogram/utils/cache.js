const MAX_ENTRIES = 1000;
const MAX_VISIBLE = 100;
const safeInteger = value => Number.isSafeInteger(value) && value >= 0;

function validEntry(entry) {
  return entry && safeInteger(entry.seq) && entry.seq > 0 &&
    ['motion', 'test'].includes(entry.type) && ['sounded', 'muted', 'disarmed'].includes(entry.result) &&
    typeof entry.bootId === 'string' && entry.bootId.length > 0 && entry.bootId.length <= 64 &&
    safeInteger(entry.uptimeMs) && safeInteger(entry.epochMs) &&
    safeInteger(entry.distanceCm) && entry.distanceCm <= 65535 && safeInteger(entry.energy) && entry.energy <= 100;
}

class LogCache {
  constructor(deviceId, storage, onError = () => {}) {
    if (typeof deviceId !== 'string' || !deviceId) throw new Error('缺少设备标识');
    this.deviceId = deviceId;
    this.storage = storage;
    this.onError = onError;
    this.key = 'sentinel.logs.v1.' + encodeURIComponent(deviceId);
    this.cursor = 0;
    this.entries = [];
    this.gap = false;
    try {
      const saved = storage.getStorageSync(this.key);
      if (saved && saved.version === 1 && saved.deviceId === deviceId) {
        this.cursor = safeInteger(saved.cursor) ? saved.cursor : 0;
        this.entries = this.dedupe(Array.isArray(saved.entries) ? saved.entries : []);
      }
    } catch (error) { onError(error); }
  }
  dedupe(entries) {
    const unique = new Map();
    entries.forEach(entry => { if (validEntry(entry)) unique.set(entry.seq, {
      seq: entry.seq, bootId: entry.bootId, uptimeMs: entry.uptimeMs, epochMs: entry.epochMs,
      type: entry.type, result: entry.result, distanceCm: entry.distanceCm, energy: entry.energy
    }); });
    return Array.from(unique.values()).sort((a, b) => a.seq - b.seq).slice(-MAX_ENTRIES);
  }
  merge(entries) {
    // Live notifications may arrive ahead of an incomplete history sync. They
    // must never advance the confirmed pagination cursor.
    this.entries = this.dedupe(this.entries.concat(entries || []));
    this.scheduleSave();
  }
  applyPage(page) {
    if (!page || !Array.isArray(page.entries) || page.entries.length > 5 ||
      !safeInteger(page.next) || typeof page.hasMore !== 'boolean' ||
      !page.entries.every(validEntry)) throw new Error('设备返回的记录页无效');
    let previous = this.cursor;
    for (const entry of page.entries) {
      if (entry.seq <= previous) throw new Error('记录顺序无效，已停止同步');
      previous = entry.seq;
    }
    if (page.entries.length && page.next !== previous) throw new Error('记录游标不匹配');
    if (!page.entries.length && page.next !== this.cursor) throw new Error('空记录页不能跳过游标');
    if (page.hasMore && page.next <= this.cursor) throw new Error('记录同步没有进展');
    if (page.next < this.cursor) throw new Error('记录游标发生回退');
    if (page.reset) {
      this.gap = true;
      if (safeInteger(page.oldest) && page.oldest > 0) this.entries = this.entries.filter(entry => entry.seq >= page.oldest);
      else if (page.count === 0) this.entries = [];
    }
    this.merge(page.entries);
    this.cursor = page.next;
    this.scheduleSave();
    return page.hasMore;
  }
  clear(latest) {
    this.entries = [];
    this.gap = false;
    if (safeInteger(latest)) this.cursor = Math.max(this.cursor, latest);
    this.flush();
  }
  visible() { return this.entries.slice(-MAX_VISIBLE).reverse(); }
  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), 250);
  }
  flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try { this.storage.setStorageSync(this.key, { version: 1, deviceId: this.deviceId, cursor: this.cursor, entries: this.entries }); }
    catch (error) { this.onError(error); }
  }
}

function relativeTime(milliseconds) {
  const seconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return `${hours}时${String(minutes).padStart(2, '0')}分${String(seconds % 60).padStart(2, '0')}秒`;
}
function timeLabel(entry) {
  if (!entry.epochMs) return `启动 ${entry.bootId.slice(-6)} +${relativeTime(entry.uptimeMs)}（未校时）`;
  // Explicit UTC+8 conversion, independent of the phone's timezone.
  const date = new Date(entry.epochMs + 8 * 3600000);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}
function displayEntry(entry) {
  return Object.assign({}, entry, {
    label: entry.type === 'test' ? '手动测试' : '活动触发',
    resultLabel: ({ sounded: '已启动鸣叫', muted: '静音，仅记录', disarmed: '未布防，仅记录' })[entry.result] || entry.result,
    timeLabel: timeLabel(entry),
    detail: entry.type === 'test' ? '不计入活动触发次数' : '一轮检测输出片段，不代表人数'
  });
}

module.exports = { LogCache, MAX_ENTRIES, MAX_VISIBLE, validEntry, displayEntry, timeLabel };
