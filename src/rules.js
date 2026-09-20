"use strict";

/**
 * 判断规则模块（纯函数，不依赖请求入口与记录存储）。
 *
 * 复核台判定规则：
 * - 复测登记三项指标：落角 dropAngle、传动阻力 transmissionResistance、摆幅 amplitude。
 * - 任一项相对机芯档案基线的偏差绝对值「超过一成二（12%）」即不合格，退回原工位。
 * - 重复值（三项指标与历史复测完全一致）不进入合格判断。
 * - 结论永远按「当前机芯档案」现算：更换轮系后旧基线失效，排队复测自动按新档案重算。
 */

const TOLERANCE = 0.12; // 一成二
const EPSILON = 1e-9; // 浮点误差兜底：恰好 12% 不算「超过」

const MEASURE_FIELDS = ["dropAngle", "transmissionResistance", "amplitude"];

/** 相对偏差：(测量值 - 基线值) / 基线值；基线为 0 时测量值非 0 视为无穷偏差。 */
function deviation(measured, baseline) {
  const m = Number(measured);
  const b = Number(baseline);
  if (!Number.isFinite(m) || !Number.isFinite(b)) return NaN;
  if (b === 0) return m === 0 ? 0 : m > 0 ? Infinity : -Infinity;
  return (m - b) / b;
}

function round6(value) {
  return Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;
}

/**
 * 用一组测量值对照档案基线做合格判断。
 * @returns {{deviations: object, exceeded: string[], maxAbsDeviation: number|null, qualified: boolean}}
 */
function judgeMeasurements(measurements, baseline) {
  const deviations = {};
  const exceeded = [];
  let maxAbs = 0;
  for (const field of MEASURE_FIELDS) {
    const raw = deviation(measurements[field], baseline[field]);
    const abs = Math.abs(raw);
    if (!Number.isFinite(raw) || abs > TOLERANCE + EPSILON) exceeded.push(field);
    deviations[field] = round6(raw);
    if (Number.isFinite(abs)) maxAbs = Math.max(maxAbs, abs);
  }
  return {
    deviations,
    exceeded,
    maxAbsDeviation: round6(maxAbs),
    qualified: exceeded.length === 0
  };
}

/** 三项指标逐一相等即为重复值。 */
function sameMeasurements(a, b) {
  return MEASURE_FIELDS.every((field) => Number(a[field]) === Number(b[field]));
}

/** 同一机芯历史复测中已出现相同三项指标（旧版遗留记录与已是重复值的记录不参与比对）。 */
function isDuplicate(measurements, retestHistory) {
  return retestHistory.some((item) => !item.legacy && !item.duplicate && sameMeasurements(item, measurements));
}

/** 能进入合格判断的复测：排除旧版遗留记录与重复值记录。 */
function effectiveRetests(retests) {
  return retests.filter((item) => !item.legacy && !item.duplicate);
}

/** 最近一次有效复测（按 testedAt，时间相同取后登记的一条）。 */
function latestEffective(retests) {
  const effective = effectiveRetests(retests);
  if (!effective.length) return null;
  return effective.reduce((latest, item) => {
    if (!latest) return item;
    const latestTime = new Date(latest.testedAt).getTime();
    const itemTime = new Date(item.testedAt).getTime();
    return itemTime >= latestTime ? item : latest;
  }, null);
}

/**
 * 当前结论：最近一次有效复测对照当前档案现算。
 * 换轮系后档案版本更新，同一批复测记录会算出新结论——旧基线就此失效。
 */
function conclude(retests, baseline) {
  const retest = latestEffective(retests);
  if (!retest || !baseline) return { retest: retest || null, judgement: null, qualified: false };
  const judgement = judgeMeasurements(retest, baseline);
  return { retest, judgement, qualified: judgement.qualified };
}

module.exports = {
  TOLERANCE,
  MEASURE_FIELDS,
  deviation,
  judgeMeasurements,
  sameMeasurements,
  isDuplicate,
  effectiveRetests,
  latestEffective,
  conclude
};
