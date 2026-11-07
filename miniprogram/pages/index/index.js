const { SentinelClient, message } = require('../../utils/ble');
const protocol = require('../../utils/protocol');
const { LogCache, displayEntry, MAX_VISIBLE } = require('../../utils/cache');
const { toDraft, makePatch, NUMERIC_FIELDS, SOUND_VALUES } = require('../../utils/form');

const PHASES = { warmup: '启动稳定中', ready: '等待新活动', sounding: '正在鸣叫', cooldown: '冷却中', waiting_release: '等待活动结束', sensor_offline: '雷达未连接或数据过期' };
const SENSOR_OPTIONS = ['HC-SR505 红外模块', 'LD2410C 雷达模块'];
const BUZZER_OPTIONS = ['无源模块（PWM）', '有源模块（开关）'];
const SOUND_OPTIONS = ['单音', '双响', '叮咚', '警报'];
const soundIndex = sound => Math.max(0, SOUND_VALUES.indexOf(sound));

const page = {
  data: {
    tab: 'device', devices: [], scanning: false, scanHint: '打开蓝牙，在设备附近搜索', seenCount: 0,
    connecting: false, connected: false, connectedName: '', stableDeviceId: '', version: '',
    error: '', actionBusy: false, stopping: false, syncing: false, syncHint: '', cacheWarning: '',
    phaseLabel: '未连接设备', phase: 'disconnected', motionLabel: '—', presenceLabel: '—', sounding: false,
    armed: false, muted: false, triggerCount: 0, distanceLabel: '—', energyLabel: '—', timeKnown: false,
    config: Object.assign({}, protocol.DEFAULT_CONFIG), draft: toDraft(protocol.DEFAULT_CONFIG), dirty: false,
    sensorOptions: SENSOR_OPTIONS, sensorIndex: 0, buzzerOptions: BUZZER_OPTIONS, buzzerIndex: 0,
    soundOptions: SOUND_OPTIONS, soundIndex: 0, savedSoundLabel: SOUND_OPTIONS[0],
    advanced: false, logs: [], visibleLimit: 25, cachedCount: 0, canShowMore: false, cacheDeviceLabel: '', gapWarning: '',
    diagnostics: '', storageWarning: ''
  },
  onLoad() {
    this._alive = true; this._visible = true; this._syncToken = 0; this._pendingActions = 0;
    this._latestState = null;
    this.client = new SentinelClient({ events: {
      onDevices: (devices, seenCount) => {
        this._nearbyUpdate = { devices, seenCount };
        if (this._deviceTimer) return;
        this._deviceTimer = setTimeout(() => { this._deviceTimer = null; this._set(this._nearbyUpdate); }, 150);
      },
      onScanProgress: scanHint => this._set({ scanHint }),
      onScanEnd: result => this._set({ scanning: false, scanHint: result.matched ? `搜索结束，发现 ${result.matched} 个感应器` : `未找到感应器（附近发现 ${result.seen} 个蓝牙设备）` }),
      onConnection: (connected, device, reason) => {
        if (connected) this._set({ connected: true, connectedName: device.name, scanning: false });
        else {
          ++this._syncToken;
          clearTimeout(this._stateTimer); this._stateTimer = null; this._latestState = null;
          this._set({ connected: false, sounding: false, phase: 'disconnected', phaseLabel: '连接已断开，设备继续本地运行', syncing: false, syncHint: '' });
          if (reason && !/连接已关闭/.test(reason.message || '')) this._set({ error: message(reason) });
        }
      },
      onState: state => {
        this._latestState = state;
        if (!this._visible || this._stateTimer) return;
        this._stateTimer = setTimeout(() => { this._stateTimer = null; this._renderState(); }, 200);
      },
      onLog: entry => {
        if (!this.cache || !this.data.connected) return;
        this.cache.merge([entry]);
        if (this._logTimer) return;
        this._logTimer = setTimeout(() => { this._logTimer = null; this._renderLogs(); }, 200);
      }
    } });
    try {
      const last = wx.getStorageSync('sentinel.lastDevice.v1');
      if (last && typeof last.deviceId === 'string') this._openCache(last.deviceId, last.name || last.deviceId);
    } catch (_) { this._set({ cacheWarning: '手机缓存读取失败，连接后可重新同步设备记录' }); }
  },
  onShow() { this._visible = true; if (this._alive) this._renderState(); },
  onHide() {
    this._visible = false;
    ++this._syncToken;
    if (this.cache) this.cache.flush();
    if (this.client) { this.client.stopScan(true).catch(() => {}); this.client.disconnect().catch(() => {}); }
    this._set({ scanning: false, syncing: false });
  },
  onUnload() {
    this._alive = false; ++this._syncToken;
    ['_deviceTimer', '_stateTimer', '_logTimer'].forEach(key => clearTimeout(this[key]));
    if (this.cache) this.cache.flush();
    if (this.client) this.client.destroy().catch(() => {});
  },
  _set(values) { if (this._alive) this.setData(values); },
  _error(error) { this._set({ error: message(error) }); },
  _openCache(deviceId, name) {
    if (this.cache) this.cache.flush();
    this._set({ cacheDeviceLabel: name, cacheWarning: '', visibleLimit: 25, gapWarning: '' });
    this.cache = new LogCache(deviceId, wx, () => this._set({ cacheWarning: '手机缓存读写失败；请检查手机存储空间，可尝试重新同步设备现有记录' }));
    this._renderLogs();
  },
  _renderLogs() {
    if (!this.cache) return;
    const recent = this.cache.visible();
    this._set({ logs: recent.slice(0, this.data.visibleLimit).map(displayEntry), cachedCount: this.cache.entries.length,
      canShowMore: recent.length > this.data.visibleLimit,
      gapWarning: this.cache.gap ? '部分较早记录已被设备清除或覆盖，现已从可用记录继续同步' : '' });
  },
  _renderState() {
    const state = this._latestState;
    if (!state || !this._alive || !this._visible || !this.data.connected) return;
    this._set({
      phase: state.phase, phaseLabel: PHASES[state.phase] || state.phase || '状态未知',
      sounding: state.sounding === true, motionLabel: state.motion ? '检测到活动' : '暂无新活动',
      presenceLabel: this.data.config.sensor === 'radar' ? state.present ? '有人体存在' : '暂无人体存在' : 'PIR 不判断静止存在',
      triggerCount: state.triggerCount || 0, timeKnown: state.timeKnown === true,
      distanceLabel: this.data.config.sensor === 'radar' && Number.isFinite(state.distanceCm) ? `${state.distanceCm} cm（参考）` : '—',
      energyLabel: this.data.config.sensor === 'radar' && Number.isFinite(state.motionEnergy) ? `${state.motionEnergy} / 100` : '—',
      diagnostics: `运行 ${Math.floor((state.uptimeMs || 0) / 1000)} 秒 · 丢弃事件 ${state.queueDrops || 0} · 丢弃发送 ${state.txDrops || 0}`,
      storageWarning: state.storageReady === false || state.storageErrors > 0 ? `设备存储异常（错误计数 ${state.storageErrors || 0}），新记录可能尚未掉电保存。请同步到手机备份并检查设备存储。` : ''
    });
  },
  _snapshot(snapshot, replaceDraft = false) {
    if (!snapshot || !snapshot.config || !snapshot.state) throw new Error('设备快照无效');
    const config = Object.assign({}, snapshot.config);
    const changes = { config, armed: config.armed === true, muted: config.muted === true, stableDeviceId: snapshot.deviceId,
      version: snapshot.version, savedSoundLabel: SOUND_OPTIONS[soundIndex(config.sound)], error: '' };
    if (replaceDraft || !this.data.dirty) Object.assign(changes, { draft: toDraft(config), dirty: false, sensorIndex: config.sensor === 'radar' ? 1 : 0, buzzerIndex: config.buzzerMode === 'active' ? 1 : 0, soundIndex: soundIndex(config.sound) });
    this._set(changes);
    this._latestState = snapshot.state; this._renderState();
  },
  changeTab(event) { this._set({ tab: event.currentTarget.dataset.tab }); },
  async scan() {
    if (this.data.scanning || this.data.connecting || this.data.connected) return;
    this._set({ scanning: true, devices: [], error: '' });
    try { await this.client.scan(); }
    catch (error) { this._set({ scanning: false }); this._error(error); }
  },
  stopScan() { this.client.stopScan(false).catch(error => this._error(error)); },
  async connect(event) {
    if (this.data.connecting) return;
    const device = this.data.devices[Number(event.currentTarget.dataset.index)];
    if (!device) return;
    this._set({ connecting: true, scanning: false, error: '', cacheWarning: '' });
    try {
      const snapshot = await this.client.connect(device);
      this._snapshot(snapshot, true);
      this._openCache(snapshot.deviceId, device.name);
      try { wx.setStorageSync('sentinel.lastDevice.v1', { deviceId: snapshot.deviceId, name: device.name }); }
      catch (_) { this._set({ cacheWarning: '手机无法保存设备信息；当前连接仍可使用' }); }
      await this.syncLogs();
    } catch (error) { this._error(error); }
    finally { this._set({ connecting: false }); }
  },
  disconnect() { this.client.disconnect().catch(error => this._error(error)); },
  async _run(op, fields = {}, successText) {
    if (!this.data.connected || (this.data.actionBusy && op !== 'stop')) return null;
    if (op === 'stop' && this.data.stopping) return null;
    ++this._pendingActions;
    this._set({ actionBusy: true, stopping: op === 'stop' || this.data.stopping, error: '' });
    try {
      const snapshot = await this.client.request(op, fields);
      if (!this._alive) return null;
      this._snapshot(snapshot, op === 'set' && fields.config && (Object.keys(fields.config).some(key => key !== 'armed' && key !== 'muted')));
      if (successText) wx.showToast({ title: successText, icon: 'success' });
      return snapshot;
    } catch (error) { this._error(error); return null; }
    finally { --this._pendingActions; this._set({ actionBusy: this._pendingActions > 0, stopping: op === 'stop' ? false : this.data.stopping }); }
  },
  async changeArmed(event) {
    const desired = event.detail.value;
    this._set({ armed: this.data.config.armed });
    await this._run('set', { config: { armed: desired } });
    this._set({ armed: this.data.config.armed });
  },
  async changeMuted(event) {
    const desired = event.detail.value;
    this._set({ muted: this.data.config.muted });
    await this._run('set', { config: { muted: desired } });
    this._set({ muted: this.data.config.muted });
  },
  stop() { return this._run('stop', {}, '已停止输出'); },
  test() {
    wx.showModal({ title: '试听设备声音', content: `将按设备已保存的“${this.data.savedSoundLabel}”和响铃时长试听，绕过布防和静音，并单独记为测试记录。未保存的修改不会用于试听。`, confirmText: '开始试听', success: result => { if (result.confirm) this._run('test', {}, '设备试听已启动'); } });
  },
  refresh() { return this._run('get'); },
  draftNumber(event) {
    const field = event.currentTarget.dataset.field;
    if (!NUMERIC_FIELDS.includes(field)) return;
    this._set({ ['draft.' + field]: event.detail.value, dirty: true });
  },
  sensorChange(event) {
    const index = Number(event.detail.value);
    if (![0, 1].includes(index)) return;
    this._set({ sensorIndex: index, 'draft.sensor': index ? 'radar' : 'pir', dirty: true });
  },
  buzzerChange(event) {
    const index = Number(event.detail.value);
    if (![0, 1].includes(index)) return;
    this._set({ buzzerIndex: index, 'draft.buzzerMode': index ? 'active' : 'passive', dirty: true });
  },
  soundChange(event) {
    const index = Number(event.detail.value);
    if (!Number.isInteger(index) || index < 0 || index >= SOUND_VALUES.length) return;
    this._set({ soundIndex: index, 'draft.sound': SOUND_VALUES[index], dirty: true });
  },
  polarityChange(event) { this._set({ 'draft.activeLow': event.detail.value, dirty: true }); },
  toggleAdvanced() { this._set({ advanced: !this.data.advanced }); },
  discardDraft() {
    const config = this.data.config;
    this._set({ draft: toDraft(config), dirty: false, sensorIndex: config.sensor === 'radar' ? 1 : 0, buzzerIndex: config.buzzerMode === 'active' ? 1 : 0, soundIndex: soundIndex(config.sound) });
  },
  async save() {
    if (!this.data.connected || this.data.actionBusy) return;
    let patch;
    try { patch = makePatch(this.data.draft, this.data.config); }
    catch (error) { this._error(error); return; }
    if (!Object.keys(patch).length) { wx.showToast({ title: '参数没有变化', icon: 'none' }); return; }
    await this._run('set', { config: patch }, '设备已确认并保存');
  },
  async syncLogs() {
    if (!this.data.connected || !this.cache || this.data.syncing) return;
    const token = ++this._syncToken, cache = this.cache;
    this._set({ syncing: true, syncHint: '正在同步设备记录…' });
    try {
      let more = true, pageCount = 0;
      while (more && token === this._syncToken && this.data.connected && cache === this.cache) {
        if (++pageCount > 210) throw new Error('记录页数异常，已停止同步，请重新连接');
        const result = await this.client.request('logs', { after: cache.cursor, limit: 5 });
        if (token !== this._syncToken || cache !== this.cache) return;
        more = cache.applyPage(result);
        if (pageCount % 5 === 0 || !more) {
          this._renderLogs(); this._set({ syncHint: `已缓存 ${cache.entries.length} 条记录${more ? '，继续同步…' : ''}` });
        }
      }
      cache.flush();
    } catch (error) { if (token === this._syncToken) this._error(error); }
    finally { if (token === this._syncToken) this._set({ syncing: false }); }
  },
  cancelSync() { ++this._syncToken; if (this.cache) this.cache.flush(); this._set({ syncing: false, syncHint: '已暂停，下次从已确认游标继续' }); },
  showMore() { this._set({ visibleLimit: Math.min(MAX_VISIBLE, this.data.visibleLimit + 25) }); this._renderLogs(); },
  clearLogs() {
    if (!this.data.connected || this.data.syncing || this.data.actionBusy) return;
    wx.showModal({ title: '清除设备记录？', content: '这会清除当前设备上的触发和测试记录，并清空此设备的手机缓存。记录序号不会重置。', confirmText: '确认清除', confirmColor: '#b54435', success: async result => {
      if (!result.confirm) return;
      const cache = this.cache;
      const snapshot = await this._run('clear');
      if (snapshot && cache === this.cache) {
        cache.clear(snapshot.logs && snapshot.logs.latest); this._renderLogs();
        this._set({ syncHint: '设备已确认清除' });
      }
    } });
  },
  openPermissions() { if (typeof wx.openSetting === 'function') wx.openSetting({}); },
  dismissError() { this._set({ error: '' }); }
};

if (typeof Page === 'function') Page(page);
module.exports = page;
