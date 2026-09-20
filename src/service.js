"use strict";

/**
 * 复核台业务编排：组合判断规则（rules）作用于数据对象。
 * 不触碰文件存储与 HTTP——读库/写库由请求入口负责，本层只在内存数据上工作。
 */

const rules = require("./rules");

function fail(status, message, extra) {
  const error = new Error(message);
  error.status = status;
  if (extra) error.extra = extra;
  throw error;
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function toNumber(value, field) {
  const num = Number(value);
  if (value === undefined || value === null || value === "" || !Number.isFinite(num)) {
    fail(400, `字段 ${field} 必须是数字`);
  }
  return num;
}

function toTimestamp(value, field) {
  if (value === undefined || value === null || value === "") return nowIso();
  const time = Date.parse(value);
  if (Number.isNaN(time)) fail(400, `字段 ${field} 必须是合法时间`);
  return new Date(time).toISOString();
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) fail(404, "钟表不存在");
  return clock;
}

/** 当前机芯档案：版本号最大的一版；旧版本保留在 archives 中供追查。 */
function currentArchive(db, clockId) {
  const versions = db.archives.filter((item) => item.clockId === clockId);
  if (!versions.length) fail(409, "该机芯缺少档案基线，无法复核");
  return versions.reduce((a, b) => (b.version > a.version ? b : a));
}

function pendingReview(db, clockId) {
  return db.reviews.find((item) => item.clockId === clockId && item.status === "pending") || null;
}

function clockRetests(db, clockId) {
  return db.retests.filter((item) => item.clockId === clockId);
}

/** 列表/详情共用的派生视图：结论按当前档案现算，保证各入口一致。 */
function clockSummary(db, clock) {
  const archive = currentArchive(db, clock.id);
  const conclusion = rules.conclude(clockRetests(db, clock.id), archive);
  return {
    ...clock,
    currentArchive: archive,
    pendingReview: pendingReview(db, clock.id),
    latestRetest: conclusion.retest,
    qualified: conclusion.qualified,
    conclusion: conclusion.retest
      ? {
          retestId: conclusion.retest.id,
          archiveVersion: archive.version,
          qualified: conclusion.qualified,
          deviations: conclusion.judgement.deviations,
          exceeded: conclusion.judgement.exceeded,
          maxAbsDeviation: conclusion.judgement.maxAbsDeviation
        }
      : null
  };
}

function listClocks(db, qualifiedFilter) {
  let data = db.clocks.map((clock) => clockSummary(db, clock));
  if (qualifiedFilter !== null && qualifiedFilter !== undefined) {
    data = data.filter((clock) => clock.qualified === qualifiedFilter);
  }
  return data;
}

/** 建表即建机芯档案 v1（落角/传动阻力/摆幅基线）。 */
function createClock(db, body) {
  const clock = {
    id: makeId("clock"),
    code: body.code,
    escapementType: body.escapementType,
    balanceFrequency: body.balanceFrequency,
    targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
    note: body.note || "",
    createdAt: nowIso()
  };
  const archive = {
    id: makeId("archive"),
    clockId: clock.id,
    version: 1,
    dropAngle: toNumber(body.dropAngle, "dropAngle"),
    transmissionResistance: toNumber(body.transmissionResistance, "transmissionResistance"),
    amplitude: toNumber(body.amplitude, "amplitude"),
    reason: "初始建档",
    note: body.archiveNote || "",
    createdAt: clock.createdAt
  };
  db.clocks.push(clock);
  db.archives.push(archive);
  return { clock, archive };
}

/**
 * 占用复核工位：每只表同一时刻只能有一处待复核工位。
 * 同一机芯再次占用 → 409 冲突，且调用方保证不落库（此处先校验后变更）。
 */
function occupyStation(db, clockId, body) {
  const clock = findClock(db, clockId);
  const existing = pendingReview(db, clock.id);
  if (existing) {
    fail(409, "同一机芯已占用一处待复核工位，不能重复占用", {
      conflictingReviewId: existing.id,
      station: existing.station
    });
  }
  const review = {
    id: makeId("review"),
    clockId: clock.id,
    station: body.station,
    status: "pending",
    archiveVersionAtOpen: currentArchive(db, clock.id).version,
    openedAt: nowIso(),
    closedAt: null,
    returnCount: 0,
    lastReturnedAt: null,
    note: body.note || ""
  };
  db.reviews.push(review);
  return review;
}

/**
 * 复测登记：落角、传动阻力、摆幅。
 * - 任一项偏离当前机芯档案超过一成二 → 不合格，退回原工位（工位保持待复核）。
 * - 重复值照常留痕，但不进入合格判断，也不改变工位状态。
 */
function registerRetest(db, clockId, body) {
  const clock = findClock(db, clockId);
  const measurements = {
    dropAngle: toNumber(body.dropAngle, "dropAngle"),
    transmissionResistance: toNumber(body.transmissionResistance, "transmissionResistance"),
    amplitude: toNumber(body.amplitude, "amplitude")
  };
  let review;
  if (body.reviewId) {
    review = db.reviews.find((item) => item.id === body.reviewId && item.clockId === clock.id);
    if (!review) fail(404, "复核工位记录不存在");
    if (review.status !== "pending") {
      fail(409, "该复核工位已办结，不能登记复测", { reviewId: review.id, status: review.status });
    }
  } else {
    review = pendingReview(db, clock.id);
    if (!review) fail(409, "该机芯当前没有待复核工位，请先占用工位");
  }
  const archive = currentArchive(db, clock.id);
  const duplicate = rules.isDuplicate(measurements, clockRetests(db, clock.id));
  const judgement = duplicate ? null : rules.judgeMeasurements(measurements, archive);
  const retest = {
    id: makeId("retest"),
    clockId: clock.id,
    reviewId: review.id,
    archiveVersion: archive.version,
    testedAt: toTimestamp(body.testedAt, "testedAt"),
    ...measurements,
    deviations: judgement ? judgement.deviations : null,
    exceeded: judgement ? judgement.exceeded : [],
    duplicate,
    qualified: judgement ? judgement.qualified : false,
    returnedToStation: judgement ? !judgement.qualified : false,
    note: body.note || ""
  };
  db.retests.push(retest);
  if (judgement) {
    if (judgement.qualified) {
      review.status = "passed";
      review.closedAt = nowIso();
    } else {
      // 退回原工位：工位仍由该机芯占用，等待返修后再次复测
      review.returnCount += 1;
      review.lastReturnedAt = nowIso();
    }
  }
  return { retest, review, archive };
}

/**
 * 更换轮系：生成新版机芯档案，旧基线即刻失效。
 * 排队中的复测（仍待复核工位的最近有效复测）按新档案重算，重算过程留痕；
 * 旧版本档案保留在 archives 中，随时可查。
 */
function replaceGearTrain(db, clockId, body) {
  const clock = findClock(db, clockId);
  const previousArchive = currentArchive(db, clock.id);
  const archive = {
    id: makeId("archive"),
    clockId: clock.id,
    version: previousArchive.version + 1,
    dropAngle: toNumber(body.dropAngle, "dropAngle"),
    transmissionResistance: toNumber(body.transmissionResistance, "transmissionResistance"),
    amplitude: toNumber(body.amplitude, "amplitude"),
    reason: body.reason || "更换轮系",
    note: body.note || "",
    createdAt: nowIso()
  };
  db.archives.push(archive);
  const recalculations = [];
  for (const review of db.reviews.filter((item) => item.clockId === clock.id && item.status === "pending")) {
    const queued = rules.latestEffective(db.retests.filter((item) => item.reviewId === review.id));
    if (!queued) continue;
    const judgement = rules.judgeMeasurements(queued, archive);
    const previousStatus = review.status;
    if (judgement.qualified) {
      review.status = "passed";
      review.closedAt = nowIso();
    }
    recalculations.push({
      id: makeId("recalc"),
      clockId: clock.id,
      reviewId: review.id,
      retestId: queued.id,
      archiveVersion: archive.version,
      previousStatus,
      newStatus: review.status,
      deviations: judgement.deviations,
      qualified: judgement.qualified,
      createdAt: nowIso()
    });
  }
  db.recalculations.push(...recalculations);
  return { archive, previousArchive, recalculations };
}

function listArchives(db, clockId) {
  findClock(db, clockId);
  const current = currentArchive(db, clockId);
  return db.archives
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => a.version - b.version)
    .map((item) => ({ ...item, current: item.version === current.version }));
}

function listReviews(db, clockId, status) {
  return db.reviews
    .filter((item) => (!clockId || item.clockId === clockId) && (!status || item.status === status))
    .sort((a, b) => new Date(a.openedAt) - new Date(b.openedAt));
}

function listRetests(db, { clockId, qualified }) {
  return db.retests
    .filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || qualified === undefined || item.qualified === qualified;
      return matchClock && matchQualified;
    })
    .sort((a, b) => new Date(a.testedAt) - new Date(b.testedAt));
}

function latestRetestView(db, clockId) {
  const clock = findClock(db, clockId);
  const archive = currentArchive(db, clock.id);
  const conclusion = rules.conclude(clockRetests(db, clock.id), archive);
  if (!conclusion.retest) return null;
  return {
    retest: conclusion.retest,
    archiveVersion: archive.version,
    conclusion: {
      qualified: conclusion.qualified,
      deviations: conclusion.judgement.deviations,
      exceeded: conclusion.judgement.exceeded,
      maxAbsDeviation: conclusion.judgement.maxAbsDeviation
    }
  };
}

function clockHistory(db, clockId) {
  const clock = findClock(db, clockId);
  const summary = clockSummary(db, clock);
  return {
    clock,
    currentArchive: summary.currentArchive,
    archives: listArchives(db, clockId),
    reviews: listReviews(db, clockId),
    retests: listRetests(db, { clockId }),
    adjustments: db.adjustments.filter((item) => item.clockId === clockId),
    recalculations: db.recalculations.filter((item) => item.clockId === clockId),
    latestRetest: summary.latestRetest,
    qualified: summary.qualified,
    conclusion: summary.conclusion
  };
}

/** 以下为原有调校记录能力，保持不变。 */
function addAdjustment(db, clockId, body) {
  const clock = findClock(db, clockId);
  const adjustment = {
    id: makeId("adjustment"),
    clockId: clock.id,
    currentDailyRateSeconds: toNumber(body.currentDailyRateSeconds, "currentDailyRateSeconds"),
    direction: body.direction,
    amount: body.amount,
    note: body.note || "",
    createdAt: nowIso()
  };
  db.adjustments.push(adjustment);
  return adjustment;
}

function listAdjustments(db, clockId) {
  return db.adjustments.filter((item) => !clockId || item.clockId === clockId);
}

module.exports = {
  listClocks,
  createClock,
  clockSummary,
  clockHistory,
  occupyStation,
  registerRetest,
  replaceGearTrain,
  listArchives,
  listReviews,
  listRetests,
  latestRetestView,
  addAdjustment,
  listAdjustments,
  findClock
};
