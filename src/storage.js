"use strict";

/**
 * 记录存储模块：只负责 data/db.json 的读写、旧结构迁移与写入串行化。
 * 不含任何判断规则，也不感知 HTTP。
 */

const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "..", "data", "db.json");

/** 旧档案迁移时的兜底基线（仅在没有机芯档案的远古数据上启用）。 */
const LEGACY_ARCHIVE_DEFAULTS = { dropAngle: 8.5, transmissionResistance: 18, amplitude: 270 };

const emptyData = {
  clocks: [],
  archives: [],
  reviews: [],
  retests: [],
  recalculations: [],
  adjustments: []
};

/** 把旧版库结构补齐到复核台范式，返回可安全使用的数据对象。 */
function migrate(db) {
  const data = { ...emptyData, ...db };
  for (const key of Object.keys(emptyData)) {
    if (!Array.isArray(data[key])) data[key] = [];
  }
  for (const clock of data.clocks) {
    if (!data.archives.some((archive) => archive.clockId === clock.id)) {
      data.archives.push({
        id: `archive_${clock.id}_v1`,
        clockId: clock.id,
        version: 1,
        ...LEGACY_ARCHIVE_DEFAULTS,
        reason: "初始建档（迁移）",
        note: "",
        createdAt: clock.createdAt || new Date().toISOString()
      });
    }
  }
  for (const retest of data.retests) {
    if (retest.dropAngle === undefined) {
      // 旧版日差复测记录：保留可查，但不进入合格判断与重复值比对
      retest.legacy = true;
    }
    if (typeof retest.duplicate !== "boolean") retest.duplicate = false;
  }
  return data;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeDb(emptyData);
  }
}

async function readDb() {
  await ensureDb();
  return migrate(JSON.parse(await readFile(DB_FILE, "utf8")));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

/** 写入串行化：占工位、复测、换轮系等变更按到达顺序落库，避免并发请求互相覆盖。 */
let queue = Promise.resolve();
function withLock(task) {
  const run = queue.then(task);
  queue = run.catch(() => {});
  return run;
}

module.exports = { DB_FILE, readDb, writeDb, withLock, migrate };
