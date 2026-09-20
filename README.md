# 机械钟表擒纵复核台API

纯后端零依赖 Node 服务。在原钟表调校服务之上扩展为**擒纵落角与轮系阻力复核台**：
每只表占用一处复核工位，复测登记落角 / 传动阻力 / 摆幅，对照机芯档案按一成二（12%）容差判定，
更换轮系后旧基线失效、排队复测按新档案重算，旧版档案全程可查。

## 结构（三层彼此独立）

```
server.js        启动引导
src/router.js    请求入口：HTTP 路由、请求解析、响应输出
src/service.js   业务编排：占工位 / 复测登记 / 更换轮系，只组合规则不碰存储与HTTP
src/rules.js     判断规则：偏差计算、一成二判定、重复值识别、结论推导（纯函数）
src/storage.js   记录存储：data/db.json 读写、旧结构迁移、写入串行化
```

判断规则不依赖入口与存储；存储不含任何判定逻辑；结论全部由持久化记录现算，
因此列表、历史与刷新（重启）后的结论始终一致。

## 启动与测试

```bash
PORT=3021 node server.js
node test/run-tests.js   # 端到端测试（独立临时库，不影响 data/db.json）
```

## 领域规则

- **工位占用**：每只表同一时刻只能有一处 `pending` 复核工位；同一机芯再次占用返回 `409` 且不落库。
- **复测判定**：登记 `dropAngle`、`transmissionResistance`、`amplitude` 三项；
  任一项相对当前机芯档案的偏差绝对值 **超过一成二（12%）** 即不合格并**退回原工位**
  （工位保持待复核、`returnCount` 累加）；三项均不超限则合格，工位办结释放。
  恰好 12% 不算超过。
- **重复值**：三项指标与该机芯历史复测完全一致时，记录照常留痕（`duplicate: true`），
  但不进入合格判断、不改变工位状态与钟表结论。
- **更换轮系**：生成新版机芯档案，旧基线即刻失效；仍排队（待复核）的工位按其最近有效复测
  **对照新档案重算**，重算过程写入 `recalculations` 留痕；旧版本档案保留可追查。
- **结论现算**：钟表 `qualified` 永远由「最近有效复测 × 当前档案」现算得出，
  换轮系后结论自动翻转，无需人工干预。

## 主要接口

- `GET /health`
- `GET /clocks?qualified=` / `POST /clocks`（建表需带 `dropAngle`、`transmissionResistance`、`amplitude` 基线，即建档 v1）
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`（档案版本、工位、复测、重算留痕与当前结论）
- `GET /clocks/:id/archives`（全部档案版本，`current` 标记当前版）
- `POST /clocks/:id/reviews`（占用工位；重复占用 409）
- `GET /clocks/:id/reviews` / `GET /reviews?clockId=&status=`
- `POST /clocks/:id/retests`（登记复测；无待复核工位 409）
- `GET /clocks/:id/latest-retest`（最近有效复测 + 对照当前档案的结论）
- `POST /clocks/:id/gear-train-replacements`（更换轮系 → 新档案 + 排队复测重算）
- `GET /retests?clockId=&qualified=` / `GET /recalculations?clockId=`
- `POST /clocks/:id/adjustments` / `GET /adjustments?clockId=`（原调校记录，保持兼容）

## 闭环示例

```bash
# 1. 占用工位（再次占用 → 409 不落库）
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/reviews \
  -H 'Content-Type: application/json' -d '{"station":"A-3"}'

# 2. 登记复测：落角偏离超过一成二 → 退回原工位
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dropAngle":9.9,"transmissionResistance":18.5,"amplitude":265}'

# 3. 更换轮系：新基线生效，排队复测按新档案重算，旧版仍可追查
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/gear-train-replacements \
  -H 'Content-Type: application/json' \
  -d '{"dropAngle":9.9,"transmissionResistance":18.5,"amplitude":265,"note":"更换三轮"}'
curl http://127.0.0.1:3021/clocks/clock_demo/archives
```
