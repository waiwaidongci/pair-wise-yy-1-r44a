# 机械钟表擒纵调校与复核台 API

纯后端零依赖 Node 服务，使用 `data/db.json` 持久化。在原有走时调校闭环之上，
扩展为**擒纵落角与轮系阻力复核台**：复核工位占用、复测登记判定、轮系更换后的档案重算。

## 分层结构（请求入口 / 判断规则 / 记录存储彼此独立）

```
server.js      组装入口：装配三层并监听端口
src/http.js    请求入口：路由、请求体解析、响应组装（不含规则、不碰存储）
src/rules.js   判断规则：偏差率、一成二公差、重复值、工位冲突、档案版本（纯函数）
src/store.js   记录存储：data/db.json 读写与写事务串行化（不含规则）
src/service.js 应用编排：组合 rules 与 store，校验失败抛错即不落库
src/seed.js    初始数据
test/smoke.js  全流程冒烟测试（node test/smoke.js）
```

## 启动

```bash
PORT=3021 node server.js        # DB_FILE 可覆盖库文件路径
node test/smoke.js              # 冒烟测试（独立临时库，不影响 data/db.json）
```

## 复核台规则

- **工位占用**：每只表（同一机芯）同时只能有一处待复核工位；再次占用返回 `409` 且不落库。
- **复测登记**：登记擒纵落角 `dropAngle`、传动阻力 `transmissionResistance`、摆幅 `amplitude`，
  对照机芯档案基线，任一项偏离超过**一成二（12%）**即退回原工位；恰好 12% 不算超过。
- **重复值**：同一工单内三项数值完全一致的登记返回 `409`，不进入合格判断。
- **更换轮系**：旧基线立即失效（`superseded`），新档案版本生效；排队中的复测工单按新档案重算，
  合格即办结、仍超差则保持退回原工位；旧版本档案保留可追查。
- **一致性**：列表、历史与结论全部由持久化记录推导，重启（刷新）后一致。

## 复核台接口

- `POST /reviews` 申请复核工位 `{ clockId, station }`（冲突 409 不落库）
- `GET /reviews?status=&clockId=&movementId=&disposition=` 工单列表（含当前结论）
- `GET /reviews/:id` 工单详情（含复测记录与事件）
- `POST /reviews/:id/measurements` 复测登记 `{ dropAngle, transmissionResistance, amplitude }`
- `POST /movements` 机芯建档 `{ code, dropAngle, transmissionResistance, amplitude }`
- `GET /movements` 机芯列表（含有效档案）
- `GET /movements/:id/archives` 档案全部版本（旧版仍可追查）
- `POST /movements/:id/gear-train` 更换轮系（旧基线失效，排队复测按新档案重算）
- `POST /clocks/:id/movement` 关联机芯 `{ movementId }`

## 既有调校接口

- `GET /health`
- `GET /clocks` / `POST /clocks`（支持 `movementId`）
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`（含复核工单、复测记录与机芯档案版本）
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`

## 闭环示例

```bash
# 1. 申请复核工位
curl -X POST http://127.0.0.1:3021/reviews \
  -H 'Content-Type: application/json' \
  -d '{"clockId":"clock_demo","station":"工位甲"}'

# 2. 复测登记：落角偏离基线 25% > 一成二，退回原工位
curl -X POST http://127.0.0.1:3021/reviews/<reviewId>/measurements \
  -H 'Content-Type: application/json' \
  -d '{"dropAngle":1.5,"transmissionResistance":18,"amplitude":280}'

# 3. 更换轮系：旧基线失效，排队工单按新档案重算
curl -X POST http://127.0.0.1:3021/movements/movement_demo/gear-train \
  -H 'Content-Type: application/json' \
  -d '{"dropAngle":1.5,"transmissionResistance":18,"amplitude":280,"note":"更换轮系"}'

# 4. 追查旧版档案与工单历史
curl http://127.0.0.1:3021/movements/movement_demo/archives
curl http://127.0.0.1:3021/clocks/clock_demo/history
```
