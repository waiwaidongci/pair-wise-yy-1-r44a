"use strict";

/**
 * 请求入口模块：HTTP 路由、请求解析、响应输出。
 * 不含判断规则（rules）与存储细节（storage 仅在此做读/写/串行化调用）。
 */

const http = require("http");
const service = require("./service");
const storage = require("./storage");

const routes = [
  "GET /health",
  "GET /clocks?qualified=",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "GET /clocks/:id/archives",
  "GET /clocks/:id/reviews",
  "POST /clocks/:id/reviews",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "POST /clocks/:id/gear-train-replacements",
  "POST /clocks/:id/adjustments",
  "GET /reviews?clockId=&status=",
  "GET /retests?clockId=&qualified=",
  "GET /recalculations?clockId=",
  "GET /adjustments?clockId="
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

/** 变更类请求统一走串行化：读库 → 业务编排 → 落库；编排阶段抛错则不写库。 */
function mutate(task) {
  return storage.withLock(async () => {
    const db = await storage.readDb();
    const result = task(db);
    await storage.writeDb(db);
    return result;
  });
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const method = req.method;

  if (method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-review-api", tolerance: "一成二(12%)", routes });
  }

  if (method === "GET" && pathname === "/clocks") {
    const db = await storage.readDb();
    const qualified = url.searchParams.get("qualified");
    const data = service.listClocks(db, qualified === null ? null : qualified === "true");
    return send(res, 200, { data });
  }

  if (method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency", "dropAngle", "transmissionResistance", "amplitude"]);
    const { clock } = await mutate((db) => service.createClock(db, body));
    const db = await storage.readDb();
    const created = db.clocks.find((item) => item.id === clock.id);
    return send(res, 201, { data: service.clockSummary(db, created) });
  }

  if (method === "GET" && pathname === "/clocks/not-qualified") {
    const db = await storage.readDb();
    return send(res, 200, { data: service.listClocks(db, false) });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (method === "GET" && historyMatch) {
    const db = await storage.readDb();
    return send(res, 200, { data: service.clockHistory(db, historyMatch[1]) });
  }

  const archivesMatch = pathname.match(/^\/clocks\/([^/]+)\/archives$/);
  if (method === "GET" && archivesMatch) {
    const db = await storage.readDb();
    return send(res, 200, { data: service.listArchives(db, archivesMatch[1]) });
  }

  const reviewsMatch = pathname.match(/^\/clocks\/([^/]+)\/reviews$/);
  if (reviewsMatch && method === "GET") {
    const db = await storage.readDb();
    service.findClock(db, reviewsMatch[1]);
    return send(res, 200, { data: service.listReviews(db, reviewsMatch[1], url.searchParams.get("status")) });
  }
  if (reviewsMatch && method === "POST") {
    const body = await parseBody(req);
    required(body, ["station"]);
    const review = await mutate((db) => service.occupyStation(db, reviewsMatch[1], body));
    return send(res, 201, { data: review });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && method === "POST") {
    const body = await parseBody(req);
    required(body, ["dropAngle", "transmissionResistance", "amplitude"]);
    const clockId = retestMatch[1];
    const { retest, review } = await mutate((db) => service.registerRetest(db, clockId, body));
    const db = await storage.readDb();
    const clock = db.clocks.find((item) => item.id === clockId);
    return send(res, 201, {
      data: retest,
      review,
      clock: service.clockSummary(db, clock),
      ...(retest.duplicate ? { message: "重复值已留痕，未参与合格判断" } : {})
    });
  }

  const gearTrainMatch = pathname.match(/^\/clocks\/([^/]+)\/gear-train-replacements$/);
  if (gearTrainMatch && method === "POST") {
    const body = await parseBody(req);
    required(body, ["dropAngle", "transmissionResistance", "amplitude"]);
    const clockId = gearTrainMatch[1];
    const { archive, previousArchive, recalculations } = await mutate((db) =>
      service.replaceGearTrain(db, clockId, body)
    );
    const db = await storage.readDb();
    const clock = db.clocks.find((item) => item.id === clockId);
    return send(res, 201, { data: archive, previousArchive, recalculations, clock: service.clockSummary(db, clock) });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (method === "GET" && latestMatch) {
    const db = await storage.readDb();
    return send(res, 200, { data: service.latestRetestView(db, latestMatch[1]) });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && method === "POST") {
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const adjustment = await mutate((db) => service.addAdjustment(db, adjustmentMatch[1], body));
    return send(res, 201, { data: adjustment });
  }

  if (method === "GET" && pathname === "/reviews") {
    const db = await storage.readDb();
    return send(res, 200, {
      data: service.listReviews(db, url.searchParams.get("clockId"), url.searchParams.get("status"))
    });
  }

  if (method === "GET" && pathname === "/retests") {
    const db = await storage.readDb();
    const qualified = url.searchParams.get("qualified");
    return send(res, 200, {
      data: service.listRetests(db, {
        clockId: url.searchParams.get("clockId"),
        qualified: qualified === null ? null : qualified === "true"
      })
    });
  }

  if (method === "GET" && pathname === "/recalculations") {
    const db = await storage.readDb();
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.recalculations.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (method === "GET" && pathname === "/adjustments") {
    const db = await storage.readDb();
    return send(res, 200, { data: service.listAdjustments(db, url.searchParams.get("clockId")) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

function createServer() {
  return http.createServer((req, res) => {
    handle(req, res).catch((error) =>
      send(res, error.status || 500, { error: error.message || "服务器错误", ...(error.extra || {}) })
    );
  });
}

module.exports = { createServer, routes };
