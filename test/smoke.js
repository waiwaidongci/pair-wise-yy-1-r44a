"use strict";

/**
 * 冒烟测试：擒纵落角与轮系阻力复核台全流程。
 * 覆盖：工位占用冲突不落库、复测登记判定、超一成二退回原工位、
 * 重复值不进合格判断、更换轮系后排队复测按新档案重算、
 * 旧版档案可追查、重启后列表/历史结论一致。
 *
 * 运行：node test/smoke.js
 */

const { spawn } = require("child_process");
const { rm } = require("fs/promises");
const path = require("path");
const os = require("os");

const PORT = 3399;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(os.tmpdir(), `bench-smoke-${process.pid}.json`);

let server = null;
let passed = 0;
let failed = 0;

function check(name, condition, extra) {
  if (condition) {
    passed += 1;
    console.log(`  ok - ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL - ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ""}`);
  }
}

async function api(method, pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
}

async function startServer() {
  server = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), DB_FILE },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("服务启动超时")), 8000);
    server.stdout.on("data", () => {
      clearTimeout(timer);
      resolve();
    });
    server.stderr.on("data", (chunk) => process.stderr.write(chunk));
  });
}

async function stopServer() {
  if (!server) return;
  server.kill();
  await new Promise((resolve) => server.on("exit", resolve));
  server = null;
}

async function main() {
  await rm(DB_FILE, { force: true });
  await startServer();

  console.log("== 既有调校接口保持可用 ==");
  let r = await api("GET", "/health");
  check("health 200", r.status === 200 && r.body.ok === true);
  r = await api("GET", "/clocks");
  check("钟表列表含演示表且已关联机芯", r.status === 200 && r.body.data[0].movementId === "movement_demo");
  r = await api("POST", "/clocks/clock_demo/retests", { dailyRateSeconds: 12, amplitude: 252 });
  check("既有复测接口可用", r.status === 201 && r.body.data.qualified === true);

  console.log("== 工位占用：每只表/同一机芯只能有一处待复核工位 ==");
  r = await api("POST", "/reviews", { clockId: "clock_demo", station: "工位A" });
  check("申请工位 201", r.status === 201 && r.body.data.status === "pending");
  const review1 = r.body.data;
  check("新工单结论为待复测登记", review1.disposition === "awaiting_measurement");

  r = await api("POST", "/reviews", { clockId: "clock_demo", station: "工位B" });
  check("同表重复占用返回 409", r.status === 409);
  let list = await api("GET", "/reviews");
  check("冲突不落库：仍只有 1 条工单", list.body.data.length === 1, list.body.data);

  r = await api("POST", "/clocks", {
    code: "CLK-2026-01",
    escapementType: "同轴擒纵",
    balanceFrequency: "25200vph",
    movementId: "movement_demo"
  });
  check("新建钟表并关联同一机芯", r.status === 201);
  const clock2 = r.body.data;
  r = await api("POST", "/reviews", { clockId: clock2.id, station: "工位C" });
  check("同一机芯再次占用返回 409", r.status === 409);
  list = await api("GET", "/reviews");
  check("机芯级冲突同样不落库", list.body.data.length === 1, list.body.data);

  console.log("== 复测登记：对照机芯档案，一成二为界 ==");
  r = await api("POST", `/reviews/${review1.id}/measurements`, {
    dropAngle: 1.25,
    transmissionResistance: 18.5,
    amplitude: 282
  });
  check("偏差在一成二内判定合格", r.status === 201 && r.body.data.measurement.verdict === "passed");
  check("工单办结", r.body.data.review.status === "passed" && r.body.data.review.disposition === "qualified");

  r = await api("POST", `/reviews/${review1.id}/measurements`, {
    dropAngle: 1.3,
    transmissionResistance: 18,
    amplitude: 280
  });
  check("已办结工单拒绝再登记", r.status === 409);

  r = await api("POST", "/reviews", { clockId: "clock_demo", station: "工位A" });
  check("办结后可再次申请工位", r.status === 201);
  const review2 = r.body.data;

  r = await api("POST", `/reviews/${review2.id}/measurements`, {
    dropAngle: 1.5,
    transmissionResistance: 18,
    amplitude: 280
  });
  check("落角超一成二退回原工位", r.status === 201 && r.body.data.measurement.verdict === "returned");
  check("工单结论为已退回原工位", r.body.data.review.disposition === "returned");
  check("退回事件记录原工位", r.body.data.review.events.some((e) => e.type === "returned" && e.station === "工位A"));

  r = await api("POST", `/reviews/${review2.id}/measurements`, {
    dropAngle: 1.5,
    transmissionResistance: 18,
    amplitude: 280
  });
  check("重复值返回 409", r.status === 409);
  let detail = await api("GET", `/reviews/${review2.id}`);
  check("重复值不进合格判断：复测记录仍 1 条", detail.body.data.measurements.length === 1, detail.body.data.measurements);

  r = await api("POST", `/reviews/${review2.id}/measurements`, {
    dropAngle: 1.5,
    transmissionResistance: 19,
    amplitude: 280
  });
  check("不同数值可再次登记", r.status === 201 && r.body.data.measurement.verdict === "returned");

  console.log("== 更换轮系：旧基线失效，排队复测按新档案重算，旧版可追查 ==");
  r = await api("POST", "/movements/movement_demo/gear-train", {
    dropAngle: 1.5,
    transmissionResistance: 19,
    amplitude: 280,
    note: "更换二轮与三轮"
  });
  check("更换轮系生成新档案版本", r.status === 201 && r.body.data.archive.version === 2 && r.body.data.archive.status === "active");
  check("旧基线已失效", r.body.data.superseded.status === "superseded" && r.body.data.superseded.supersededAt !== null);
  check("排队工单按新档案重算合格", r.body.data.recalculatedReviews.length === 1 && r.body.data.recalculatedReviews[0].status === "passed");

  r = await api("GET", "/movements/movement_demo/archives");
  check("旧版档案仍可追查", r.status === 200 && r.body.data.length === 2 && r.body.data.some((a) => a.version === 1 && a.status === "superseded"));

  detail = await api("GET", `/reviews/${review2.id}`);
  check("重算结论来源为 recalculation", detail.body.data.evaluation.source === "recalculation" && detail.body.data.evaluation.archiveVersion === 2);

  console.log("== 一成二边界：恰好 12% 不算超过 ==");
  r = await api("POST", "/reviews", { clockId: "clock_demo", station: "工位B" });
  const review3 = r.body.data;
  r = await api("POST", `/reviews/${review3.id}/measurements`, {
    dropAngle: 1.68,
    transmissionResistance: 19,
    amplitude: 280
  });
  check("恰好 12% 判定合格", r.status === 201 && r.body.data.review.status === "passed", r.body);

  r = await api("POST", "/reviews", { clockId: "clock_demo", station: "工位B" });
  const review4 = r.body.data;
  r = await api("POST", `/reviews/${review4.id}/measurements`, {
    dropAngle: 1.69,
    transmissionResistance: 19,
    amplitude: 280
  });
  check("超过 12% 退回原工位", r.status === 201 && r.body.data.review.disposition === "returned");

  console.log("== 参数与路由校验 ==");
  r = await api("POST", "/reviews", { clockId: "clock_demo" });
  check("缺少工位字段返回 400", r.status === 400);
  r = await api("POST", "/reviews", { clockId: "clock_none", station: "工位X" });
  check("钟表不存在返回 404", r.status === 404);
  r = await api("GET", "/reviews/review_none");
  check("工单不存在返回 404", r.status === 404);
  r = await api("GET", "/no-such-route");
  check("未知路由返回 404", r.status === 404);

  console.log("== 重启（刷新）后列表、历史结论一致 ==");
  const beforeList = (await api("GET", "/reviews")).body.data;
  const beforeHistory = (await api("GET", "/clocks/clock_demo/history")).body.data;
  await stopServer();
  await startServer();

  const afterList = (await api("GET", "/reviews")).body.data;
  const afterHistory = (await api("GET", "/clocks/clock_demo/history")).body.data;
  check(
    "重启后列表结论一致",
    JSON.stringify(afterList.map((i) => [i.id, i.status, i.disposition])) ===
      JSON.stringify(beforeList.map((i) => [i.id, i.status, i.disposition])),
    afterList
  );
  check(
    "重启后历史结论一致",
    JSON.stringify(afterHistory.reviews.map((i) => [i.id, i.status, i.disposition, i.measurements.length])) ===
      JSON.stringify(beforeHistory.reviews.map((i) => [i.id, i.status, i.disposition, i.measurements.length]))
  );
  check("历史含机芯档案全部版本", afterHistory.movementArchives.length === 2);
  check("历史与列表结论一致",
    afterHistory.reviews.every((hr) => {
      const item = afterList.find((li) => li.id === hr.id);
      return item && item.disposition === hr.disposition && item.status === hr.status;
    })
  );

  await stopServer();
  await rm(DB_FILE, { force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  await stopServer();
  await rm(DB_FILE, { force: true });
  process.exit(1);
});
