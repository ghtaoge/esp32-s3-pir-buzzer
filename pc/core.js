(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SentinelCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const MAX_LOGS = 1000;
  const RESULT_LABELS = { sounded: '已启动鸣叫', muted: '静音，仅记录', disarmed: '未布防，仅记录', output_failed: '蜂鸣器输出失败' };
  function supportsPassivePolarity(version) {
    const parts = typeof version === 'string' && /^(\d+)\.(\d+)\.(\d+)(?:-demo)?$/.exec(version);
    if (!parts) return false;
    const [major, minor, patch] = parts.slice(1).map(Number);
    return major > 1 || (major === 1 && (minor > 0 || patch >= 3));
  }
  function assertBuzzerConfigSupported(version, config) {
    if (config.buzzerMode === 'passive' && config.activeLow === true && !supportsPassivePolarity(version)) {
      throw new Error('无源模块低电平驱动需要固件 1.0.3 或更新版本，请先升级固件。');
    }
  }
  function resultLabel(result) { return typeof result === 'string' && Object.prototype.hasOwnProperty.call(RESULT_LABELS, result) ? RESULT_LABELS[result] : result; }
  function validEntry(entry) {
    return entry && Number.isSafeInteger(entry.seq) && entry.seq > 0 &&
      ['motion', 'test'].includes(entry.type) && typeof entry.result === 'string' && Object.prototype.hasOwnProperty.call(RESULT_LABELS, entry.result) &&
      Number.isFinite(entry.uptimeMs) && entry.uptimeMs >= 0 && Number.isFinite(entry.epochMs) && entry.epochMs >= 0;
  }
  class LogStore {
    constructor(deviceId, storage) {
      if (typeof deviceId !== 'string' || !deviceId || deviceId.length > 80) throw new Error('设备标识无效');
      this.deviceId = deviceId;
      this.storage = storage;
      this.key = 'sentinel.v1.logs.' + deviceId;
      this.entries = new Map();
      this.cursor = 0;
      this.cacheAvailable = !!storage;
      try {
        const raw = storage && storage.getItem(this.key);
        if (raw && raw.length <= 800000) {
          const saved = JSON.parse(raw);
          if (saved.deviceId === deviceId && Number.isSafeInteger(saved.cursor) && saved.cursor >= 0 && Array.isArray(saved.entries)) {
            this.cursor = saved.cursor;
            this.merge(saved.entries.slice(-MAX_LOGS));
          }
        }
      } catch (_) { this.cacheAvailable = false; }
    }
    merge(entries) {
      for (const entry of entries.slice(-MAX_LOGS)) if (validEntry(entry)) this.entries.set(entry.seq, {
        seq: entry.seq, bootId: String(entry.bootId || '').slice(0, 40), uptimeMs: entry.uptimeMs,
        epochMs: entry.epochMs, type: entry.type, result: entry.result,
        distanceCm: Number.isFinite(entry.distanceCm) ? entry.distanceCm : 0,
        energy: Number.isFinite(entry.energy) ? entry.energy : 0
      });
      if (this.entries.size > MAX_LOGS) {
        const keys = [...this.entries.keys()].sort((a, b) => a - b);
        for (const key of keys.slice(0, keys.length - MAX_LOGS)) this.entries.delete(key);
      }
    }
    applyPage(page, previousCursor) {
      if (!page || !Array.isArray(page.entries) || page.entries.length > 5 ||
          !Number.isSafeInteger(page.next) || page.next < previousCursor ||
          (page.hasMore && page.next <= previousCursor)) throw new Error('记录分页响应无效，请重新连接');
      let previous = previousCursor;
      for (const entry of page.entries) {
        if (!validEntry(entry) || entry.seq <= previous) throw new Error('记录序号不连续递增');
        previous = entry.seq;
      }
      if (page.entries.length && previous !== page.next) throw new Error('记录游标不匹配');
      if (!page.entries.length && page.next !== previousCursor) throw new Error('空记录页不能跳过同步游标');
      if (page.reset) {
        for (const key of this.entries.keys()) if (!page.count || key < page.oldest) this.entries.delete(key);
      }
      this.merge(page.entries);
      this.cursor = page.next;
    }
    persist() {
      try {
        if (this.storage) this.storage.setItem(this.key, JSON.stringify({ deviceId: this.deviceId, cursor: this.cursor, entries: this.list(false) }));
      } catch (_) { this.cacheAvailable = false; }
    }
    clear(latest) { this.entries.clear(); this.cursor = Number.isSafeInteger(latest) ? latest : this.cursor; this.persist(); }
    list(descending = true) { return [...this.entries.values()].sort((a, b) => descending ? b.seq - a.seq : a.seq - b.seq); }
  }
  function displayTime(entry) {
    if (!entry.epochMs) return `开机后 ${(entry.uptimeMs / 1000).toFixed(1)} 秒 · ${entry.bootId || '未校时'}`;
    return new Date(entry.epochMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
  }
  function csvCell(value) {
    let text = String(value == null ? '' : value);
    if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }
  function toCsv(entries) {
    const rows = [['序号', '时间（北京时间或开机相对时间）', '类型', '结果', '启动编号']];
    for (const entry of entries) rows.push([entry.seq, displayTime(entry), entry.type, entry.result, entry.bootId]);
    return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  }
  return { MAX_LOGS, LogStore, validEntry, displayTime, csvCell, toCsv, resultLabel, supportsPassivePolarity, assertBuzzerConfigSupported };
});
