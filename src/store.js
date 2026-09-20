"use strict";

/**
 * 记录存储层：只负责 data/db.json 的读写与写事务串行化，
 * 不包含任何判断规则，也不感知 HTTP。
 */

const { readFile, writeFile, rename, mkdir } = require("fs/promises");
const path = require("path");

const COLLECTIONS = [
  "clocks",
  "adjustments",
  "retests",
  "movements",
  "movementArchives",
  "reviews",
  "measurements"
];

function createStore({ dbFile, seed }) {
  async function ensureDb() {
    await mkdir(path.dirname(dbFile), { recursive: true });
    try {
      JSON.parse(await readFile(dbFile, "utf8"));
    } catch {
      await writeFile(dbFile, JSON.stringify(seed(), null, 2));
    }
  }

  function normalize(db) {
    for (const name of COLLECTIONS) {
      if (!Array.isArray(db[name])) db[name] = [];
    }
    return db;
  }

  async function read() {
    await ensureDb();
    return normalize(JSON.parse(await readFile(dbFile, "utf8")));
  }

  async function write(db) {
    // 先写临时文件再改名，避免半截文件
    const tmp = `${dbFile}.tmp`;
    await writeFile(tmp, JSON.stringify(normalize(db), null, 2));
    await rename(tmp, dbFile);
  }

  // 写事务串行化：规则校验抛错时不会执行 write，即不落库
  let chain = Promise.resolve();
  function transact(mutator) {
    const run = chain.then(async () => {
      const db = await read();
      const result = await mutator(db);
      await write(db);
      return result;
    });
    chain = run.catch(() => {});
    return run;
  }

  return { read, transact, dbFile };
}

module.exports = { createStore, COLLECTIONS };
