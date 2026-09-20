"use strict";

/**
 * 组装入口：请求入口（http）、判断规则（rules）、记录存储（store）
 * 彼此独立，在此装配为一个服务进程。
 */

const http = require("http");
const path = require("path");
const { createStore } = require("./src/store");
const { createService } = require("./src/service");
const { createHandler } = require("./src/http");
const { seedData } = require("./src/seed");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data", "db.json");

const store = createStore({ dbFile: DB_FILE, seed: seedData });
const service = createService(store);
const handle = createHandler(service);

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: error.message || "服务器错误" }));
  });
});

server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
});
