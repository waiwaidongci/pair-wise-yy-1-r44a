"use strict";

/** 启动引导：仅负责拉起 HTTP 服务。 */

const { createServer } = require("./src/router");
const { DB_FILE } = require("./src/storage");

const PORT = Number(process.env.PORT || 3021);

createServer().listen(PORT, () => {
  console.log(`Clock escapement review API running at http://127.0.0.1:${PORT}`);
  console.log(`DB file: ${DB_FILE}`);
});
