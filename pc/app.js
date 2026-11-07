(() => {
  'use strict';
  const P = window.SentinelProtocol, C = window.SentinelCore, T = window.SentinelTransports;
  const $ = id => document.getElementById(id), form = $('settings-form');
  const fields = form.elements;
  const seconds = new Set(['beepMs', 'cooldownMs', 'warmupMs']);
  const radarFields = ['radarMaxGate', 'radarMotionThreshold', 'radarStillThreshold'];
  let session = null, snapshot = null, logs = null, tab = 'device', page = 0, formBaseline = {};
  let frame = 0, logsDirty = true, busy = false, syncing = false, disconnecting = false, saveTimer = null;
  const names = { warmup: '传感器稳定中', ready: '等待新活动', sounding: '正在鸣叫', cooldown: '冷却中', waiting_release: '等待活动平静', sensor_offline: '传感器未就绪' };
  const resultNames = { sounded: '已启动鸣叫', muted: '静音，仅记录', disarmed: '未布防，仅记录' };
  function message(text, error = false) { $('notice').textContent = text; $('notice').classList.toggle('error', error); }
  function errorText(error) {
    if (error && error.name === 'NotFoundError') return '未选择设备，连接已取消。';
    if (error && error.name === 'SecurityError') return '浏览器未允许设备访问，请在本地地址使用 Chrome / Edge 并检查站点权限。';
    return error && error.message || String(error || '操作失败');
  }
  function queueRender() { if (!frame) frame = requestAnimationFrame(render); }
  function persistSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { if (logs) logs.persist(); }, 500); }
  function setForm(config) {
    formBaseline = { ...config };
    for (const [name, value] of Object.entries(config)) {
      const input = fields.namedItem(name); if (!input) continue;
      if (input.type === 'checkbox') input.checked = value;
      else input.value = seconds.has(name) ? value / 1000 : value;
    }
    enableFields();
  }
  function enableFields() {
    const connected = !!snapshot && !!session && !session.rpc.closed;
    const radar = fields.namedItem('sensor').value === 'radar';
    const active = fields.namedItem('buzzerMode').value === 'active';
    for (const input of form.querySelectorAll('input, select')) input.disabled = !connected || busy;
    for (const name of radarFields) fields.namedItem(name).disabled = !connected || busy || !radar;
    fields.namedItem('warmupMs').disabled = !connected || busy || radar;
    fields.namedItem('toneHz').disabled = !connected || busy || active;
    fields.namedItem('activeLow').disabled = !connected || busy || !active;
    $('sound-hint').textContent = active ? '有源蜂鸣器只改变通断节奏，音高固定；“叮咚”和“警报”也以节奏呈现。' : '无源蜂鸣器可改变节奏和音高，基础音高由下方音调设置决定。';
    $('pir-note').hidden = radar;
    $('save-settings').disabled = !connected || busy;
  }
  function applySnapshot(data, resetForm = false) {
    if (!data || typeof data.deviceId !== 'string' || !data.config || !data.state || !data.version || !data.version.startsWith('1.')) throw new Error('设备固件协议不兼容，请更新到 1.x 固件');
    if (snapshot && snapshot.deviceId !== data.deviceId) throw new Error('连接中的设备标识发生变化，请重新连接');
    snapshot = data;
    if (resetForm) setForm(data.config);
    queueRender();
  }
  function eventReceived(owner, event, data) {
    if (session !== owner || !snapshot) return;
    if (event === 'state' && data && typeof data === 'object') snapshot.state = data;
    if (event === 'log' && C.validEntry(data) && logs) { logs.merge([data]); logsDirty = true; persistSoon(); }
    queueRender();
  }
  async function disconnect(note = '连接已断开，真实设备仍独立运行。') {
    const previous = session; session = null; snapshot = null; busy = false; syncing = false; disconnecting = true;
    if (logs) logs.persist();
    queueRender();
    if (previous) { previous.rpc.close(new Error('连接已关闭')); await previous.transport.disconnect().catch(() => {}); }
    disconnecting = false;
    message(note); queueRender(); enableFields();
  }
  async function connect(kind) {
    if (session || disconnecting) return;
    const owner = { transport: null, rpc: null, kind };
    owner.rpc = new P.RpcClient({
      write: bytes => owner.transport.write(bytes),
      onEvent: (event, data) => eventReceived(owner, event, data),
      onFatal: error => { if (session === owner) disconnect('通信中断：' + errorText(error)); }
    });
    const handlers = { onBytes: bytes => { if (session === owner) owner.rpc.receive(bytes); }, onDisconnect: error => { if (session === owner) disconnect('设备已断开：' + errorText(error)); } };
    owner.transport = new ({ serial: T.SerialTransport, ble: T.BluetoothTransport, demo: T.DemoTransport }[kind])(handlers);
    session = owner; busy = true; queueRender(); message('正在连接，请选择设备并确认浏览器授权…');
    try {
      await owner.transport.connect();
      if (session !== owner) throw new Error('连接已取消');
      const data = await owner.rpc.request('get');
      if (session !== owner) return;
      applySnapshot(data, true);
      let cacheStorage = null;
      if (kind !== 'demo') { try { cacheStorage = window.localStorage; } catch (_) { /* Device control must work with browser storage disabled. */ } }
      logs = new C.LogStore(data.deviceId, cacheStorage); page = 0; logsDirty = true;
      await owner.rpc.request('time', { epochMs: Date.now() }).then(data => { if (session === owner) applySnapshot(data); });
      if (session !== owner) return;
      busy = false; enableFields(); queueRender();
      message(kind === 'demo' ? '已进入演示模式，所有事件和读数均为模拟。' : '连接成功，参数来自设备；正在同步离线记录。');
      await syncLogs();
    } catch (error) { if (session === owner) { await disconnect(errorText(error)); message(errorText(error), true); } }
    finally { if (session !== owner) { owner.rpc.close(new Error('连接已取消')); await owner.transport.disconnect().catch(() => {}); } }
  }
  async function command(op, values = {}, text = '') {
    const owner = session; if (!owner || !snapshot) throw new Error('请先连接设备');
    const data = await owner.rpc.request(op, values);
    if (session !== owner) return null;
    applySnapshot(data);
    if (text) message(owner.kind === 'demo' ? '演示：' + text : text);
    return data;
  }
  async function act(fn) {
    if (busy) return;
    busy = true; queueRender(); enableFields();
    try { await fn(); } catch (error) { message(errorText(error), true); }
    finally { busy = false; queueRender(); enableFields(); }
  }
  async function syncLogs() {
    if (syncing || !session || !snapshot || !logs) return;
    syncing = true; queueRender();
    const owner = session, store = logs;
    try {
      let after = store.cursor, seen = 0;
      while (session === owner) {
        const data = await owner.rpc.request('logs', { after, limit: 5 });
        if (session !== owner) return;
        store.applyPage(data, after); after = data.next;
        if (data.reset) message('部分较早记录已被设备清空或覆盖，已同步仍可用的记录。');
        logsDirty = true; queueRender();
        if (!data.hasMore) break;
        if (++seen > 220) throw new Error('记录同步页数超限，请稍后重试');
      }
      if (session === owner) { store.persist(); message(owner.kind === 'demo' ? `演示日志已同步：${store.entries.size} 条，仅保存在本页内存中。` : store.cacheAvailable ? `同步完成，本机保留 ${store.entries.size} 条记录。` : '同步完成，但浏览器缓存不可用；请及时导出记录。'); }
    } catch (error) { if (session === owner) message('记录同步失败：' + errorText(error), true); }
    finally { if (session === owner) { syncing = false; queueRender(); } }
  }
  function renderLogs() {
    const entries = logs ? logs.list() : [];
    const maxPage = Math.max(0, Math.ceil(entries.length / 50) - 1); page = Math.min(page, maxPage);
    const rows = document.createDocumentFragment();
    for (const entry of entries.slice(page * 50, page * 50 + 50)) {
      const row = document.createElement('tr');
      const values = [entry.seq, C.displayTime(entry), entry.type === 'test' ? '手动测试' : '活动触发', resultNames[entry.result] || entry.result, entry.distanceCm ? (entry.distanceCm / 100).toFixed(2) + ' m' : '—'];
      for (const value of values) { const cell = document.createElement('td'); cell.textContent = value; row.append(cell); }
      rows.append(row);
    }
    if (!entries.length) { const row = document.createElement('tr'), cell = document.createElement('td'); cell.colSpan = 5; cell.className = 'empty'; cell.textContent = '尚无记录；连接设备同步，或在演示模式中模拟一次活动。'; row.append(cell); rows.append(row); }
    $('log-rows').replaceChildren(rows);
    $('page-info').textContent = `第 ${page + 1} / ${maxPage + 1} 页 · ${entries.length} 条 · 每页 50 条`;
    $('page-prev').disabled = page === 0; $('page-next').disabled = page >= maxPage;
    $('nav-log-count').textContent = entries.length;
    $('export-logs').disabled = !entries.length;
  }
  function render() {
    frame = 0;
    const connected = !!snapshot && !!session && !session.rpc.closed;
    const state = snapshot && snapshot.state;
    for (const id of ['connect-serial', 'connect-ble', 'connect-demo']) $(id).disabled = !!session || disconnecting;
    $('disconnect').disabled = !session;
    for (const id of ['armed', 'muted', 'test', 'refresh', 'clear-logs']) $(id).disabled = !connected || busy;
    $('stop').disabled = !connected; $('sync-logs').disabled = !connected || syncing;
    $('demo-banner').hidden = !connected || session.kind !== 'demo'; $('demo-actions').hidden = !connected || session.kind !== 'demo';
    $('connection-badge').className = 'badge' + (connected ? session.kind === 'demo' ? ' demo' : ' connected' : '');
    $('connection-badge').textContent = connected ? session.kind === 'demo' ? '演示模式' : '已连接 · ' + session.transport.kind : session ? '连接中…' : '未连接';
    $('device-name').textContent = connected ? (session.kind === 'demo' ? '模拟设备 · ' : 'S3-Sentinel · ') + snapshot.deviceId : '连接你的开发板';
    $('device-detail').textContent = connected ? `固件 ${snapshot.version} · ${session.transport.kind} · PIR GPIO3 / 蜂鸣器 GPIO7 / 雷达 UART17、18` : '推荐 USB 串口；也可通过附近的 BLE 设备连接。';
    $('sensor-label').textContent = connected ? snapshot.config.sensor === 'radar' ? 'LD2410C 雷达' : 'PIR 人体感应' : '—';
    $('phase').textContent = connected ? names[state.phase] || state.phase : '等待连接';
    $('presence').textContent = connected ? state.present ? state.motion ? '检测到活动目标' : '有人静止在场' : '当前未检测到目标' : '连接后查看人体活动与输出状态';
    $('motion-label').textContent = '活动 ' + (connected ? state.motion ? '有' : '无' : '—');
    $('sound-label').textContent = '蜂鸣器 ' + (connected ? state.sounding ? '正在输出' : '关闭' : '—');
    $('time-label').textContent = connected ? state.timeKnown ? '已校时' : '未校时' : '时间 —';
    $('signal-ring').classList.toggle('active', connected && state.motion);
    $('trigger-count').textContent = connected ? state.triggerCount : '—';
    $('distance').textContent = connected && snapshot.config.sensor === 'radar' && state.distanceCm > 0 ? (state.distanceCm / 100).toFixed(2) + ' m' : '—';
    $('energy').textContent = connected && snapshot.config.sensor === 'radar' ? state.motionEnergy : '—';
    $('heap').textContent = connected ? (state.freeHeap / 1024).toFixed(1) + ' KB' : '—';
    $('min-heap').textContent = connected ? (state.minFreeHeap / 1024).toFixed(1) + ' KB' : '—';
    $('loop-max').textContent = connected ? state.loopMaxUs + ' μs' : '—';
    $('drops').textContent = connected ? state.queueDrops + ' / ' + state.txDrops : '—';
    const storageReady = connected && state.storageReady !== false && (!snapshot.storage || snapshot.storage.ready !== false);
    const storageErrors = connected ? Number(state.storageErrors || snapshot.storage && snapshot.storage.errors || 0) : 0;
    $('storage-status').textContent = !connected ? '—' : !storageReady ? '尚未就绪' : storageErrors ? `${storageErrors} 次错误` : '就绪';
    $('storage-warning').hidden = !connected || (storageReady && !storageErrors);
    $('storage-warning').textContent = !storageReady ? '设备存储尚未就绪；当前记录可能尚未持久化，参数保存也可能失败。请稍后刷新状态，不要视为已保存。' : '设备报告存储错误，部分记录或设置可能未持久化；请检查后重新读取设备确认。';
    if (connected) { $('armed').checked = snapshot.config.armed; $('muted').checked = snapshot.config.muted; }
    $('settings-feedback').textContent = connected ? session.kind === 'demo' ? '演示配置；保存不会写入真实硬件。' : '保存后等待设备确认；雷达参数需模块回读成功。' : '连接设备后读取实际参数。';
    $('log-description').textContent = logs ? `${logs.deviceId} · 设备记录与本机缓存按序号去重；触发次数不代表人数。` : '连接后同步设备上的事件记录；触发次数不代表人数。';
    if (logsDirty) { renderLogs(); logsDirty = false; }
    enableFields();
  }
  function showTab(name) {
    tab = name; const titles = { device: '设备控制', settings: '硬件参数', logs: '触发记录' };
    for (const key of Object.keys(titles)) { $('tab-' + key).setAttribute('aria-selected', key === name ? 'true' : 'false'); $('panel-' + key).hidden = key !== name; }
    $('page-title').textContent = titles[name];
  }
  ['device', 'settings', 'logs'].forEach(name => $('tab-' + name).addEventListener('click', () => showTab(name)));
  document.querySelector('nav[role=tablist]').addEventListener('keydown', event => { if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return; const tabs = ['device', 'settings', 'logs']; showTab(tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : 2)) % 3]); $('tab-' + tab).focus(); event.preventDefault(); });
  $('connect-serial').addEventListener('click', () => connect('serial'));
  $('connect-ble').addEventListener('click', () => connect('ble'));
  $('connect-demo').addEventListener('click', () => connect('demo'));
  $('disconnect').addEventListener('click', () => disconnect());
  $('armed').addEventListener('change', () => { const armed = $('armed').checked; act(() => command('set', { config: { armed } }, armed ? '已布防' : '已撤防，继续记录')); });
  $('muted').addEventListener('change', () => { const muted = $('muted').checked; act(() => command('set', { config: { muted } }, muted ? '已静音，继续记录' : '已取消静音')); });
  $('stop').addEventListener('click', () => command('stop', {}, '已停止，等待活动平静后重新待命').catch(error => message(errorText(error), true)));
  $('test').addEventListener('click', () => act(() => command('test', {}, '已按设备保存的声音启动限时试听，不计入感应次数')));
  $('refresh').addEventListener('click', () => act(() => command('get', {}, '已读取设备当前状态')));
  $('sync-logs').addEventListener('click', syncLogs);
  $('demo-motion').addEventListener('click', () => { if (session && session.kind === 'demo') session.transport.simulateActivity(); });
  $('demo-held').addEventListener('click', () => { if (session && session.kind === 'demo') session.transport.simulateActivity(10000); });
  form.addEventListener('change', enableFields);
  form.addEventListener('submit', event => {
    event.preventDefault(); if (!snapshot) return;
    let config;
    try {
      config = {};
      for (const [name, previous] of Object.entries(formBaseline)) {
        const input = fields.namedItem(name); if (!input || input.disabled) continue;
        if (input.type !== 'checkbox' && input.value.trim() === '') throw new Error('请填写完整参数');
        const value = typeof previous === 'boolean' ? input.checked : typeof previous === 'number' ? Number(input.value) * (seconds.has(name) ? 1000 : 1) : input.value;
        if (value !== previous) config[name] = value;
      }
      P.validateConfig(config, snapshot.config);
    } catch (error) { message(errorText(error), true); return; }
    if (!Object.keys(config).length) { message('参数没有变化，无需保存。'); return; }
    act(async () => {
      const data = await command('set', { config }, '设备已确认，参数已生效');
      if (data) setForm(data.config);
    });
  });
  $('clear-logs').addEventListener('click', () => {
    if (!window.confirm('清空这台设备的历史记录及对应本机缓存？此操作无法撤销。')) return;
    act(async () => { const data = await command('clear'); if (data && logs) { logs.clear(data.logs.latest); page = 0; logsDirty = true; message('该设备记录已清空。'); } });
  });
  $('export-logs').addEventListener('click', () => {
    if (!logs) return;
    const url = URL.createObjectURL(new Blob([C.toCsv(logs.list(false))], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'sentinel-' + logs.deviceId.replace(/[^a-zA-Z0-9_-]/g, '_') + '.csv'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  $('page-prev').addEventListener('click', () => { page = Math.max(0, page - 1); logsDirty = true; queueRender(); });
  $('page-next').addEventListener('click', () => { page++; logsDirty = true; queueRender(); });
  window.addEventListener('pagehide', () => { clearTimeout(saveTimer); if (logs) logs.persist(); if (session) { session.rpc.close(new Error('页面已关闭')); session.transport.disconnect().catch(() => {}); } });
  setForm(P.DEFAULT_CONFIG); render();
})();
