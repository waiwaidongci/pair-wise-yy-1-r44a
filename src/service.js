"use strict";

/**
 * 应用服务层：编排判断规则（rules）与记录存储（store）。
 * 不感知 HTTP 细节，校验失败抛出带 status 的错误；
 * 在 transact 内抛错即不落库。
 */

const rules = require("./rules");

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function now() {
  return new Date().toISOString();
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw httpError(400, `缺少字段：${missing.join(", ")}`);
}

function toFiniteNumber(value, field) {
  if (value === undefined || value === null || value === "") {
    throw httpError(400, `缺少字段：${field}`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw httpError(400, `字段 ${field} 必须是数字`);
  return n;
}

/** 复测登记三项指标：擒纵落角、传动阻力、摆幅 */
function pickMeasureValues(body) {
  const values = {};
  for (const field of rules.MEASURE_FIELDS) {
    values[field] = toFiniteNumber(body[field], field);
  }
  return values;
}

function createService(store) {
  // ---------- 通用查找 ----------
  function findClock(db, clockId) {
    const clock = db.clocks.find((item) => item.id === clockId);
    if (!clock) throw httpError(404, "钟表不存在");
    return clock;
  }

  function findMovement(db, movementId) {
    const movement = db.movements.find((item) => item.id === movementId);
    if (!movement) throw httpError(404, "机芯不存在");
    return movement;
  }

  function findReview(db, reviewId) {
    const review = db.reviews.find((item) => item.id === reviewId);
    if (!review) throw httpError(404, "复核工单不存在");
    return review;
  }

  // ---------- 既有调校业务的派生展示 ----------
  function latestBy(items, field) {
    return items.slice().sort((a, b) => new Date(b[field]) - new Date(a[field]))[0] || null;
  }

  function clockSummary(db, clock) {
    const retest = latestBy(db.retests.filter((item) => item.clockId === clock.id), "testedAt");
    const adjustment = latestBy(db.adjustments.filter((item) => item.clockId === clock.id), "createdAt");
    return {
      ...clock,
      latestAdjustment: adjustment,
      latestRetest: retest,
      qualified: retest ? retest.qualified : false
    };
  }

  // ---------- 复核工单的派生展示 ----------
  function reviewMeasurements(db, reviewId) {
    return db.measurements
      .filter((item) => item.reviewId === reviewId)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }

  function decorateReview(db, review) {
    const disposition = rules.dispositionOf(review);
    const clock = db.clocks.find((item) => item.id === review.clockId) || null;
    const movement = db.movements.find((item) => item.id === review.movementId) || null;
    return {
      ...review,
      disposition,
      dispositionLabel: rules.DISPOSITION_LABELS[disposition],
      toleranceRate: rules.TOLERANCE_RATE,
      toleranceLabel: rules.TOLERANCE_LABEL,
      clockCode: clock ? clock.code : null,
      movementCode: movement ? movement.code : null
    };
  }

  // ============ 钟表档案（既有业务） ============

  async function listClocks(query) {
    const db = await store.read();
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    const qualified = query.get("qualified");
    if (qualified !== null) {
      data = data.filter((clock) => clock.qualified === (qualified === "true"));
    }
    return data;
  }

  async function createClock(body) {
    required(body, ["code", "escapementType", "balanceFrequency"]);
    return store.transact(async (db) => {
      let movementId = null;
      if (body.movementId !== undefined && body.movementId !== null && body.movementId !== "") {
        findMovement(db, body.movementId);
        movementId = body.movementId;
      }
      const clock = {
        id: makeId("clock"),
        code: body.code,
        escapementType: body.escapementType,
        balanceFrequency: body.balanceFrequency,
        targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
        movementId,
        note: body.note || "",
        createdAt: now()
      };
      db.clocks.push(clock);
      return clockSummary(db, clock);
    });
  }

  async function listNotQualified() {
    const db = await store.read();
    return db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
  }

  async function clockHistory(clockId) {
    const db = await store.read();
    const clock = findClock(db, clockId);
    const reviews = db.reviews
      .filter((item) => item.clockId === clock.id)
      .map((review) => ({
        ...decorateReview(db, review),
        measurements: reviewMeasurements(db, review.id)
      }));
    const movementArchives = clock.movementId
      ? db.movementArchives
          .filter((item) => item.movementId === clock.movementId)
          .sort((a, b) => b.version - a.version)
      : [];
    return {
      clock,
      adjustments: db.adjustments.filter((item) => item.clockId === clock.id),
      retests: db.retests.filter((item) => item.clockId === clock.id),
      latestRetest: latestBy(db.retests.filter((item) => item.clockId === clock.id), "testedAt"),
      reviews,
      movementArchives
    };
  }

  async function createAdjustment(clockId, body) {
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    return store.transact(async (db) => {
      const clock = findClock(db, clockId);
      const adjustment = {
        id: makeId("adjustment"),
        clockId: clock.id,
        currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
        direction: body.direction,
        amount: body.amount,
        note: body.note || "",
        createdAt: now()
      };
      db.adjustments.push(adjustment);
      return adjustment;
    });
  }

  async function createRetest(clockId, body) {
    required(body, ["dailyRateSeconds", "amplitude"]);
    return store.transact(async (db) => {
      const clock = findClock(db, clockId);
      const adjustmentId =
        body.adjustmentId ||
        latestBy(db.adjustments.filter((item) => item.clockId === clock.id), "createdAt")?.id ||
        null;
      const qualified =
        body.qualified !== undefined
          ? Boolean(body.qualified)
          : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
      const retest = {
        id: makeId("retest"),
        clockId: clock.id,
        adjustmentId,
        testedAt: body.testedAt || now(),
        dailyRateSeconds: Number(body.dailyRateSeconds),
        amplitude: Number(body.amplitude),
        qualified,
        note: body.note || ""
      };
      db.retests.push(retest);
      return { retest, clock: clockSummary(db, clock) };
    });
  }

  async function latestRetestOf(clockId) {
    const db = await store.read();
    findClock(db, clockId);
    return latestBy(db.retests.filter((item) => item.clockId === clockId), "testedAt");
  }

  async function listAdjustments(query) {
    const db = await store.read();
    const clockId = query.get("clockId");
    return db.adjustments.filter((item) => !clockId || item.clockId === clockId);
  }

  async function listRetests(query) {
    const db = await store.read();
    const clockId = query.get("clockId");
    const qualified = query.get("qualified");
    return db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      return matchClock && matchQualified;
    });
  }

  // ============ 机芯档案与轮系 ============

  async function createMovement(body) {
    required(body, ["code"]);
    const values = pickMeasureValues(body);
    return store.transact(async (db) => {
      if (db.movements.some((item) => item.code === body.code)) {
        throw httpError(409, "机芯编号已存在");
      }
      const at = now();
      const movement = {
        id: makeId("movement"),
        code: body.code,
        note: body.note || "",
        createdAt: at
      };
      const archive = {
        id: makeId("archive"),
        movementId: movement.id,
        version: 1,
        ...values,
        status: "active",
        note: body.archiveNote || "初始建档",
        createdAt: at,
        supersededAt: null
      };
      db.movements.push(movement);
      db.movementArchives.push(archive);
      return { ...movement, activeArchive: archive };
    });
  }

  async function listMovements() {
    const db = await store.read();
    return db.movements.map((movement) => ({
      ...movement,
      activeArchive: rules.activeArchive(db.movementArchives, movement.id)
    }));
  }

  /** 机芯档案全部版本：旧版仍可追查 */
  async function listArchives(movementId) {
    const db = await store.read();
    findMovement(db, movementId);
    return db.movementArchives
      .filter((item) => item.movementId === movementId)
      .sort((a, b) => b.version - a.version);
  }

  async function linkMovement(clockId, body) {
    required(body, ["movementId"]);
    return store.transact(async (db) => {
      const clock = findClock(db, clockId);
      findMovement(db, body.movementId);
      const open = db.reviews.find((item) => item.clockId === clock.id && item.status === "pending");
      if (open) throw httpError(409, "钟表有待复核工单，不能更换关联机芯");
      clock.movementId = body.movementId;
      return clockSummary(db, clock);
    });
  }

  /**
   * 更换轮系：旧基线失效（superseded），新档案生效；
   * 排队中的复测工单按新档案重算，旧版本保留可追查。
   */
  async function replaceGearTrain(movementId, body) {
    const values = pickMeasureValues(body);
    return store.transact(async (db) => {
      const movement = findMovement(db, movementId);
      const current = rules.activeArchive(db.movementArchives, movementId);
      if (!current) throw httpError(409, "机芯暂无有效档案，无法更换轮系");
      const at = now();
      current.status = "superseded";
      current.supersededAt = at;
      const archive = {
        id: makeId("archive"),
        movementId,
        version: rules.nextArchiveVersion(db.movementArchives, movementId),
        ...values,
        status: "active",
        note: body.note || "更换轮系",
        createdAt: at,
        supersededAt: null
      };
      db.movementArchives.push(archive);

      // 排队复测按新档案重算
      const recalculated = [];
      const queued = db.reviews.filter(
        (item) => item.movementId === movementId && item.status === "pending"
      );
      for (const review of queued) {
        const last = reviewMeasurements(db, review.id).slice(-1)[0] || null;
        if (!last) {
          review.events.push({
            type: "baseline_invalidated",
            at,
            archiveId: archive.id,
            archiveVersion: archive.version,
            note: "旧基线失效，后续复测按新档案判定"
          });
          review.updatedAt = at;
          continue;
        }
        const evaluation = rules.evaluateAgainstArchive(last, archive);
        review.evaluation = {
          measurementId: last.id,
          archiveId: archive.id,
          archiveVersion: archive.version,
          deviations: evaluation.deviations,
          withinTolerance: evaluation.withinTolerance,
          source: "recalculation",
          evaluatedAt: at
        };
        if (evaluation.withinTolerance) {
          review.status = "passed";
          review.closedAt = at;
          review.events.push({
            type: "recalculated",
            at,
            archiveVersion: archive.version,
            result: "passed",
            note: "按新档案重算合格，工单办结"
          });
        } else {
          review.events.push({
            type: "recalculated",
            at,
            archiveVersion: archive.version,
            result: "returned",
            outOfTolerance: evaluation.outOfTolerance,
            note: `按新档案重算仍超差，退回原工位 ${review.station}`
          });
        }
        review.updatedAt = at;
        recalculated.push(decorateReview(db, review));
      }

      return { movement, archive, superseded: current, recalculatedReviews: recalculated };
    });
  }

  // ============ 复核工位与复测登记 ============

  /** 申请复核工位：每只表（同一机芯）同时只能有一处待复核工位，冲突返回 409 且不落库 */
  async function createReview(body) {
    required(body, ["clockId", "station"]);
    return store.transact(async (db) => {
      const clock = findClock(db, body.clockId);
      if (!clock.movementId) throw httpError(422, "钟表未关联机芯档案，无法申请复核工位");
      findMovement(db, clock.movementId);
      const conflict = rules.findOpenReviewForMovement(db.reviews, clock.movementId);
      if (conflict) {
        throw httpError(
          409,
          `同一机芯已占用工位 ${conflict.station}（工单 ${conflict.id}），不得重复占用`
        );
      }
      const at = now();
      const review = {
        id: makeId("review"),
        clockId: clock.id,
        movementId: clock.movementId,
        station: body.station,
        note: body.note || "",
        status: "pending",
        evaluation: null,
        events: [{ type: "created", at, station: body.station, note: "占用复核工位" }],
        createdAt: at,
        updatedAt: at,
        closedAt: null
      };
      db.reviews.push(review);
      return decorateReview(db, review);
    });
  }

  async function listReviews(query) {
    const db = await store.read();
    let items = db.reviews.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const status = query.get("status");
    if (status) items = items.filter((item) => item.status === status);
    const clockId = query.get("clockId");
    if (clockId) items = items.filter((item) => item.clockId === clockId);
    const movementId = query.get("movementId");
    if (movementId) items = items.filter((item) => item.movementId === movementId);
    const disposition = query.get("disposition");
    let decorated = items.map((item) => decorateReview(db, item));
    if (disposition) decorated = decorated.filter((item) => item.disposition === disposition);
    return decorated;
  }

  async function getReview(reviewId) {
    const db = await store.read();
    const review = findReview(db, reviewId);
    return {
      ...decorateReview(db, review),
      measurements: reviewMeasurements(db, review.id)
    };
  }

  /**
   * 复测登记：落角、传动阻力、摆幅对照机芯档案，
   * 任一项偏离超过一成二即退回原工位；重复值不能进入合格判断。
   */
  async function registerMeasurement(reviewId, body) {
    const values = pickMeasureValues(body);
    return store.transact(async (db) => {
      const review = findReview(db, reviewId);
      if (review.status !== "pending") {
        throw httpError(409, "复核工单已办结，不能再登记复测值");
      }
      const archive = rules.activeArchive(db.movementArchives, review.movementId);
      if (!archive) throw httpError(422, "机芯档案缺失，无法判定");
      const existing = reviewMeasurements(db, review.id);
      if (rules.isDuplicateMeasurement(existing, values)) {
        throw httpError(409, "重复值不能进入合格判断");
      }
      const evaluation = rules.evaluateAgainstArchive(values, archive);
      const at = now();
      const measurement = {
        id: makeId("measurement"),
        reviewId: review.id,
        clockId: review.clockId,
        movementId: review.movementId,
        archiveId: archive.id,
        archiveVersion: archive.version,
        ...values,
        deviations: evaluation.deviations,
        outOfTolerance: evaluation.outOfTolerance,
        withinTolerance: evaluation.withinTolerance,
        verdict: evaluation.withinTolerance ? "passed" : "returned",
        note: body.note || "",
        createdAt: at
      };
      db.measurements.push(measurement);
      review.evaluation = {
        measurementId: measurement.id,
        archiveId: archive.id,
        archiveVersion: archive.version,
        deviations: evaluation.deviations,
        withinTolerance: evaluation.withinTolerance,
        source: "measurement",
        evaluatedAt: at
      };
      if (evaluation.withinTolerance) {
        review.status = "passed";
        review.closedAt = at;
        review.events.push({
          type: "passed",
          at,
          measurementId: measurement.id,
          archiveVersion: archive.version,
          note: "复测合格，工单办结"
        });
      } else {
        review.events.push({
          type: "returned",
          at,
          measurementId: measurement.id,
          station: review.station,
          outOfTolerance: evaluation.outOfTolerance,
          note: `超差退回原工位 ${review.station}`
        });
      }
      review.updatedAt = at;
      return { measurement, review: decorateReview(db, review) };
    });
  }

  return {
    listClocks,
    createClock,
    listNotQualified,
    clockHistory,
    createAdjustment,
    createRetest,
    latestRetestOf,
    listAdjustments,
    listRetests,
    createMovement,
    listMovements,
    listArchives,
    linkMovement,
    replaceGearTrain,
    createReview,
    listReviews,
    getReview,
    registerMeasurement
  };
}

module.exports = { createService };
