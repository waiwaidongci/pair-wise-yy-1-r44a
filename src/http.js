"use strict";

/**
 * 请求入口层：HTTP 路由、请求体解析、响应组装。
 * 不包含判断规则，也不直接读写存储，只调用应用服务。
 */

const ROUTES = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "POST /clocks/:id/movement",
  "GET /adjustments",
  "GET /retests",
  "POST /movements",
  "GET /movements",
  "GET /movements/:id/archives",
  "POST /movements/:id/gear-train",
  "POST /reviews",
  "GET /reviews",
  "GET /reviews/:id",
  "POST /reviews/:id/measurements"
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

function compile(pattern) {
  const keys = [];
  const regex = new RegExp(
    "^" + pattern.replace(/:[^/]+/g, (segment) => {
      keys.push(segment.slice(1));
      return "([^/]+)";
    }) + "$"
  );
  return { keys, regex };
}

function createHandler(service) {
  const table = [
    { method: "GET", pattern: "/health", run: async () => [200, { ok: true, service: "clock-escapement-tuning-api", routes: ROUTES }] },
    { method: "GET", pattern: "/clocks", run: async ({ query }) => [200, { data: await service.listClocks(query) }] },
    { method: "POST", pattern: "/clocks", run: async ({ body }) => [201, { data: await service.createClock(body) }] },
    { method: "GET", pattern: "/clocks/not-qualified", run: async () => [200, { data: await service.listNotQualified() }] },
    { method: "GET", pattern: "/clocks/:id/history", run: async ({ params }) => [200, { data: await service.clockHistory(params.id) }] },
    { method: "POST", pattern: "/clocks/:id/adjustments", run: async ({ params, body }) => [201, { data: await service.createAdjustment(params.id, body) }] },
    {
      method: "POST",
      pattern: "/clocks/:id/retests",
      run: async ({ params, body }) => {
        const result = await service.createRetest(params.id, body);
        return [201, { data: result.retest, clock: result.clock }];
      }
    },
    { method: "GET", pattern: "/clocks/:id/latest-retest", run: async ({ params }) => [200, { data: await service.latestRetestOf(params.id) }] },
    { method: "POST", pattern: "/clocks/:id/movement", run: async ({ params, body }) => [200, { data: await service.linkMovement(params.id, body) }] },
    { method: "GET", pattern: "/adjustments", run: async ({ query }) => [200, { data: await service.listAdjustments(query) }] },
    { method: "GET", pattern: "/retests", run: async ({ query }) => [200, { data: await service.listRetests(query) }] },
    { method: "POST", pattern: "/movements", run: async ({ body }) => [201, { data: await service.createMovement(body) }] },
    { method: "GET", pattern: "/movements", run: async () => [200, { data: await service.listMovements() }] },
    { method: "GET", pattern: "/movements/:id/archives", run: async ({ params }) => [200, { data: await service.listArchives(params.id) }] },
    { method: "POST", pattern: "/movements/:id/gear-train", run: async ({ params, body }) => [201, { data: await service.replaceGearTrain(params.id, body) }] },
    { method: "POST", pattern: "/reviews", run: async ({ body }) => [201, { data: await service.createReview(body) }] },
    { method: "GET", pattern: "/reviews", run: async ({ query }) => [200, { data: await service.listReviews(query) }] },
    { method: "GET", pattern: "/reviews/:id", run: async ({ params }) => [200, { data: await service.getReview(params.id) }] },
    { method: "POST", pattern: "/reviews/:id/measurements", run: async ({ params, body }) => [201, { data: await service.registerMeasurement(params.id, body) }] }
  ].map((route) => ({ ...route, ...compile(route.pattern) }));

  return async function handle(req, res) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
      const body = req.method === "GET" ? {} : await parseBody(req);
      for (const route of table) {
        if (route.method !== req.method) continue;
        const match = url.pathname.match(route.regex);
        if (!match) continue;
        const params = {};
        route.keys.forEach((key, index) => {
          params[key] = decodeURIComponent(match[index + 1]);
        });
        const [status, payload] = await route.run({ body, params, query: url.searchParams });
        return send(res, status, payload);
      }
      return send(res, 404, { error: "接口不存在", routes: ROUTES });
    } catch (error) {
      return send(res, error.status || 500, { error: error.message || "服务器错误" });
    }
  };
}

module.exports = { createHandler, ROUTES };
