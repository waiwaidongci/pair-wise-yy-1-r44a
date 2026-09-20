"use strict";

/**
 * 判断规则层：擒纵落角与轮系阻力复核台的全部判定逻辑。
 * 纯函数、无 I/O，不依赖请求入口与记录存储，可独立测试。
 */

// 一成二 = 12%：任一项偏离机芯档案超过该比例即退回原工位
const TOLERANCE_RATE = 0.12;
const TOLERANCE_LABEL = "一成二（12%）";
// 浮点噪声保护：恰好 12% 不算“超过”
const EPSILON = 1e-9;

// 复测登记的三项指标
const MEASURE_FIELDS = ["dropAngle", "transmissionResistance", "amplitude"];

const FIELD_LABELS = {
  dropAngle: "擒纵落角",
  transmissionResistance: "传动阻力",
  amplitude: "摆幅"
};

/** 单项偏差率 |实测 - 基线| / |基线| */
function deviationRate(measured, baseline) {
  const m = Number(measured);
  const b = Number(baseline);
  if (!Number.isFinite(m) || !Number.isFinite(b)) return Infinity;
  if (b === 0) return m === 0 ? 0 : Infinity;
  return Math.abs((m - b) / b);
}

function roundRate(rate) {
  return Number.isFinite(rate) ? Number(rate.toFixed(6)) : null;
}

/** 复测值对照机芯档案基线，给出各项偏差率与是否合格 */
function evaluateAgainstArchive(values, archive) {
  const deviations = {};
  const outOfTolerance = [];
  for (const field of MEASURE_FIELDS) {
    const rate = deviationRate(values[field], archive[field]);
    deviations[field] = roundRate(rate);
    if (rate > TOLERANCE_RATE + EPSILON) outOfTolerance.push(field);
  }
  return {
    deviations,
    outOfTolerance,
    withinTolerance: outOfTolerance.length === 0,
    toleranceRate: TOLERANCE_RATE
  };
}

/** 重复值不能进入合格判断：同一工单内三项数值完全一致即为重复 */
function isDuplicateMeasurement(measurements, values) {
  return measurements.some((item) =>
    MEASURE_FIELDS.every((field) => Number(item[field]) === Number(values[field]))
  );
}

/** 同一机芯是否已有待复核工位（status 为 pending 即占用中） */
function findOpenReviewForMovement(reviews, movementId) {
  return reviews.find((item) => item.movementId === movementId && item.status === "pending") || null;
}

/** 当前有效机芯档案（新基线） */
function activeArchive(archives, movementId) {
  return archives.find((item) => item.movementId === movementId && item.status === "active") || null;
}

/** 下一档案版本号（更换轮系时递增，旧版保留可追查） */
function nextArchiveVersion(archives, movementId) {
  return (
    archives
      .filter((item) => item.movementId === movementId)
      .reduce((max, item) => Math.max(max, Number(item.version) || 0), 0) + 1
  );
}

const DISPOSITION_LABELS = {
  qualified: "合格",
  awaiting_measurement: "待复测登记",
  returned: "已退回原工位",
  within_tolerance: "在公差内"
};

/**
 * 工单当前结论。列表、历史、刷新后共用同一推导，
 * 输入全部来自持久化记录，因此结论一致。
 */
function dispositionOf(review) {
  if (review.status === "passed") return "qualified";
  if (!review.evaluation) return "awaiting_measurement";
  return review.evaluation.withinTolerance ? "within_tolerance" : "returned";
}

module.exports = {
  TOLERANCE_RATE,
  TOLERANCE_LABEL,
  MEASURE_FIELDS,
  FIELD_LABELS,
  DISPOSITION_LABELS,
  deviationRate,
  evaluateAgainstArchive,
  isDuplicateMeasurement,
  findOpenReviewForMovement,
  activeArchive,
  nextArchiveVersion,
  dispositionOf
};
