const protocol = require('./protocol');
const NUMERIC_FIELDS = ['beepMs', 'cooldownMs', 'confirmMs', 'releaseMs', 'warmupMs', 'toneHz', 'radarMaxGate', 'radarMotionThreshold', 'radarStillThreshold'];
const RADAR_FIELDS = ['radarMaxGate', 'radarMotionThreshold', 'radarStillThreshold'];
const SOUND_VALUES = ['single', 'double', 'chime', 'siren'];

function toDraft(config) {
  const draft = Object.assign({}, config);
  NUMERIC_FIELDS.forEach(field => { draft[field] = String(config[field]); });
  return draft;
}
function parseInteger(value, label) {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) throw new Error(label + '必须是整数');
  const number = Number(value.trim());
  if (!Number.isSafeInteger(number)) throw new Error(label + '超出整数范围');
  return number;
}
const LABELS = {
  beepMs: '响铃时长', cooldownMs: '冷却时间', confirmMs: '活动确认时间', releaseMs: '连续安静时间',
  warmupMs: 'PIR启动稳定时间', toneHz: '无源蜂鸣器频率', radarMaxGate: '雷达最远距离门',
  radarMotionThreshold: '运动能量阈值', radarStillThreshold: '静止能量阈值'
};
function makePatch(draft, current) {
  if (!['pir', 'radar'].includes(draft.sensor)) throw new Error('请选择有效传感器模式');
  if (!['active', 'passive'].includes(draft.buzzerMode)) throw new Error('请选择有效蜂鸣器模式');
  if (!SOUND_VALUES.includes(draft.sound)) throw new Error('请选择有效声音预设');
  const candidate = { sensor: draft.sensor, buzzerMode: draft.buzzerMode, sound: draft.sound };
  NUMERIC_FIELDS.forEach(field => {
    if (RADAR_FIELDS.includes(field) && draft.sensor !== 'radar') return;
    if (field === 'warmupMs' && draft.sensor !== 'pir') return;
    if (field === 'toneHz' && draft.buzzerMode !== 'passive') return;
    candidate[field] = parseInteger(draft[field], LABELS[field]);
  });
  if (draft.buzzerMode === 'active') {
    if (typeof draft.activeLow !== 'boolean') throw new Error('蜂鸣器触发极性无效');
    candidate.activeLow = draft.activeLow;
  }
  protocol.validateConfig(candidate, current);
  const patch = {};
  Object.keys(candidate).forEach(key => { if (candidate[key] !== current[key]) patch[key] = candidate[key]; });
  return patch;
}

module.exports = { NUMERIC_FIELDS, RADAR_FIELDS, SOUND_VALUES, LABELS, toDraft, parseInteger, makePatch };
