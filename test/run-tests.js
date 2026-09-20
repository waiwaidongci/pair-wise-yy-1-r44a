"use strict";

/**
 * 复核台端到端测试：零依赖，直接对真实 HTTP 服务断言。
 * 运行：node test/run-tests.js
 */

const { spawn } = require("child_process");
const assert = require("assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = path.join(os.tmpdir(), `review-stand-test-${process.pid}.json`);
const SERVER = path.join(__dirname, "..", "server.js");

let server = null;
let passed = 0;

async function api(method, pathname, body) {
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✓ ${name}`);
    })
    .catch((error) => {
      console.error(`  ✗ ${name}`);
      throw error;
    });
}

async function startServer() {
  server = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), DB_FILE },
    stdio: "ignore"
  });
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("服务启动失败");
}

async function stopServer() {
  if (!server) return;
  server.kill();
  await new Promise((resolve) => server.once("exit", resolve));
  server = null;
}

async function main() {
  await startServer();
  let clockId;

  console.log("基础与建档");
  await check("健康检查", async () => {
    const { status, body } = await api("GET", "/health");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });

  await check("建表必须带机芯档案基线", async () => {
    const { status } = await api("POST", "/clocks", { code: "T-1", escapementType: "杠杆式", balanceFrequency: "18000vph" });
    assert.equal(status, 400);
  });

  await check("建表即建档 v1", async () => {
    const { status, body } = await api("POST", "/clocks", {
      code: "T-1",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      dropAngle: 10,
      transmissionResistance: 100,
      amplitude: 300
    });
    assert.equal(status, 201);
    clockId = body.data.id;
    assert.equal(body.data.currentArchive.version, 1);
    assert.equal(body.data.qualified, false);
    assert.equal(body.data.pendingReview, null);
  });

  console.log("工位占用");
  await check("未占工位不能登记复测", async () => {
    const { status } = await api("POST", `/clocks/${clockId}/retests`, { dropAngle: 10, transmissionResistance: 100, amplitude: 300 });
    assert.equal(status, 409);
  });

  await check("占用工位成功", async () => {
    const { status, body } = await api("POST", `/clocks/${clockId}/reviews`, { station: "S-1" });
    assert.equal(status, 201);
    assert.equal(body.data.status, "pending");
    assert.equal(body.data.station, "S-1");
  });

  await check("同一机芯再次占用返回冲突且不落库", async () => {
    const before = await api("GET", `/clocks/${clockId}/reviews`);
    const { status, body } = await api("POST", `/clocks/${clockId}/reviews`, { station: "S-2" });
    assert.equal(status, 409);
    assert.ok(body.conflictingReviewId);
    const after = await api("GET", `/clocks/${clockId}/reviews`);
    assert.equal(after.body.data.length, before.body.data.length);
  });

  console.log("复测与一成二判定");
  await check("三项均在 12% 内 → 合格并释放工位", async () => {
    const { status, body } = await api("POST", `/clocks/${clockId}/retests`, {
      dropAngle: 10.5,
      transmissionResistance: 103,
      amplitude: 297
    });
    assert.equal(status, 201);
    assert.equal(body.data.qualified, true);
    assert.equal(body.review.status, "passed");
    assert.equal(body.clock.qualified, true);
  });

  await check("恰好 12% 不算超过 → 合格", async () => {
    await api("POST", `/clocks/${clockId}/reviews`, { station: "S-1" });
    const { body } = await api("POST", `/clocks/${clockId}/retests`, {
      dropAngle: 11.2,
      transmissionResistance: 100,
      amplitude: 300
    });
    assert.equal(body.data.qualified, true);
    assert.equal(body.review.status, "passed");
  });

  await check("任一项超过一成二 → 退回原工位", async () => {
    await api("POST", `/clocks/${clockId}/reviews`, { station: "S-1" });
    const { body } = await api("POST", `/clocks/${clockId}/retests`, {
      dropAngle: 11.3,
      transmissionResistance: 100,
      amplitude: 300
    });
    assert.equal(body.data.qualified, false);
    assert.equal(body.data.returnedToStation, true);
    assert.deepEqual(body.data.exceeded, ["dropAngle"]);
    assert.equal(body.review.status, "pending");
    assert.equal(body.review.returnCount, 1);
    assert.equal(body.clock.qualified, false);
  });

  console.log("重复值");
  await check("重复值留痕但不进入合格判断", async () => {
    const { body } = await api("POST", `/clocks/${clockId}/retests`, {
      dropAngle: 11.3,
      transmissionResistance: 100,
      amplitude: 300,
      note: "原样重报"
    });
    assert.equal(body.data.duplicate, true);
    assert.equal(body.data.qualified, false);
    assert.equal(body.review.returnCount, 1, "工位状态不得被重复值改变");
    const latest = await api("GET", `/clocks/${clockId}/latest-retest`);
    assert.equal(latest.body.data.retest.duplicate, false, "最新有效复测不应是重复值记录");
    assert.equal(latest.body.data.retest.dropAngle, 11.3);
    const history = await api("GET", `/clocks/${clockId}/history`);
    const duplicates = history.body.data.retests.filter((item) => item.duplicate);
    assert.equal(duplicates.length, 1);
  });

  console.log("更换轮系与重算");
  await check("排队复测按新档案重算并留痕", async () => {
    const { status, body } = await api("POST", `/clocks/${clockId}/gear-train-replacements`, {
      dropAngle: 11.3,
      transmissionResistance: 100,
      amplitude: 300
    });
    assert.equal(status, 201);
    assert.equal(body.data.version, 2);
    assert.equal(body.previousArchive.version, 1);
    assert.equal(body.recalculations.length, 1);
    assert.equal(body.recalculations[0].previousStatus, "pending");
    assert.equal(body.recalculations[0].newStatus, "passed");
    assert.equal(body.clock.qualified, true);
  });

  await check("旧版档案仍可追查", async () => {
    const { body } = await api("GET", `/clocks/${clockId}/archives`);
    assert.equal(body.data.length, 2);
    assert.equal(body.data[0].version, 1);
    assert.equal(body.data[0].current, false);
    assert.equal(body.data[1].current, true);
  });

  await check("再次换轮系 → 旧基线失效、结论翻转为不合格", async () => {
    const { body } = await api("POST", `/clocks/${clockId}/gear-train-replacements`, {
      dropAngle: 10,
      transmissionResistance: 100,
      amplitude: 300
    });
    assert.equal(body.data.version, 3);
    assert.equal(body.clock.qualified, false);
    const notQualified = await api("GET", "/clocks/not-qualified");
    assert.ok(notQualified.body.data.some((item) => item.id === clockId));
  });

  console.log("刷新一致性");
  let beforeRestart;
  await check("记录重启前的列表与历史结论", async () => {
    const list = await api("GET", "/clocks");
    const history = await api("GET", `/clocks/${clockId}/history`);
    beforeRestart = {
      list: list.body.data.find((item) => item.id === clockId).conclusion,
      history: history.body.data.conclusion,
      qualified: history.body.data.qualified
    };
    assert.deepEqual(beforeRestart.list, beforeRestart.history);
  });

  await stopServer();
  await startServer();

  await check("重启后列表、历史结论一致", async () => {
    const list = await api("GET", "/clocks");
    const history = await api("GET", `/clocks/${clockId}/history`);
    const afterList = list.body.data.find((item) => item.id === clockId);
    assert.deepEqual(afterList.conclusion, beforeRestart.list);
    assert.deepEqual(history.body.data.conclusion, beforeRestart.history);
    assert.equal(afterList.qualified, beforeRestart.qualified);
    assert.equal(history.body.data.qualified, beforeRestart.qualified);
  });

  console.log("兼容与兜底");
  await check("原调校记录接口仍可用", async () => {
    const created = await api("POST", `/clocks/${clockId}/adjustments`, {
      currentDailyRateSeconds: 40,
      direction: "慢针方向",
      amount: "微调0.2格"
    });
    assert.equal(created.status, 201);
    const list = await api("GET", `/adjustments?clockId=${clockId}`);
    assert.equal(list.body.data.length, 1);
  });

  await check("未知钟表 404 / 未知路由 404", async () => {
    const missing = await api("GET", "/clocks/clock_nope/history");
    assert.equal(missing.status, 404);
    const noRoute = await api("GET", "/nope");
    assert.equal(noRoute.status, 404);
  });

  console.log(`\n全部通过：${passed} 项断言场景`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopServer();
    fs.rmSync(DB_FILE, { force: true });
  });
