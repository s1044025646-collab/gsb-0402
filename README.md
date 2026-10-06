# Welford 在线方差与分批摘要合并后端

TypeScript + Node.js + SQLite（`node:sqlite`，零运行时依赖）实现的单变量数值流在线均值/方差服务，提供 HTTP API 与 CLI。只做后端，Windows 本地运行，不需要 Docker / WSL / 外部服务。

## 快速开始

```powershell
npm install        # 安装开发依赖（typescript）
npm run build      # 编译到 dist/ 与 dist-test/
npm test           # 构建并运行全部测试
npm start          # 启动 HTTP API（默认自动选择空闲端口，PORT=8080 可指定）
npm run demo       # 运行演示（逐步统计表 + 朴素公式反例 + 合并对比）
node dist/cli.js help
```

数据目录为项目内 `data/`（默认 `data/welford.db`，可用 `--db` 或 `DB_PATH` 覆盖）。端口默认 `0`（操作系统分配空闲端口），可用 `PORT` 环境变量或 `--port` 指定。

## 核心算法

### Welford 更新

对每个新值 `x`（当前摘要 `n, mean, M2`）：

```
n'   = n + 1
δ    = x - mean
mean'= mean + δ / n'
δ2   = x - mean'
M2'  = M2 + δ · δ2
```

**禁止**用 `E[x²] − E[x]²` 代替：大基数上的小波动会发生灾难性抵消（见演示 2：`1e12` 附近三个相邻值，朴素公式算出方差 0，Welford 得到精确的 21）。

### 方差归一口径

- 总体方差 = `M2 / n`
- 样本方差 = `M2 / (n-1)`
- 空摘要：均值与两种方差均为 `null`（未定义），**不返回 0**
- 单样本：总体方差 = 0，样本方差 = `null`

### 摘要合并（Chan 公式）

```
n    = nA + nB
δ    = meanB - meanA
mean = meanA + δ · nB / n
M2   = M2A + M2B + δ² · nA · nB / n
```

- 空摘要是合并单位元；合并不修改来源（生成新快照）。
- 摘要按**多重集**处理：重复合并同一来源会重复计数，自合并 `merge(A,A)` 计数翻倍，**不具备幂等性**。这是"数据重复"，与"请求重试"不同——后者由 `requestId` 幂等键处理。
- 规则版本（`rulesVersion`）不一致的摘要拒绝合并（`RULES_VERSION_MISMATCH`）。

### M2 负值规则（公开）

M2 理论上非负。浮点误差可能产生极小负值：若 `M2 < 0` 且 `|M2| ≤ 1e-12 · max(1, n·mean²)`，视为浮点噪声截为 0；超出该容差的明显非法状态直接拒绝（`INVALID_SUMMARY`），不一律截零。

## 精度与限制

- 全部使用 IEEE-754 双精度。不承诺任意排列、任意分批方式下结果逐位相同（浮点加法不可结合），只在公开容差（测试用相对容差 `1e-12`）内一致。
- 仅凭 `n, mean, M2` 三个统计量**无法验证**其来自哪份真实原始数据；导入只做结构与合法性校验。
- 限制：`|x| ≤ 1e15`，`n ≤ 2^53-1`，单批 ≤ 1,000,000 个值，请求体 ≤ 10MB。
- 拒绝 `NaN`/`±Infinity`（`NON_FINITE_VALUE`）与超范围值（`VALUE_OUT_OF_RANGE`）。
- 批次含任一非法值时**整体拒绝**，不落前半批（内存中先整体计算，事务内一次性写入）。
- 重启后从 SQLite 恢复 `(n, mean, M2)` 继续更新，与相同顺序直接运行结果一致（有测试覆盖）。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查与规则版本 |
| POST | `/summaries` `{id?, initial?}` | 创建摘要 |
| GET | `/summaries` | 列出全部 |
| GET | `/summaries/:id` | 查询摘要 |
| POST | `/summaries/:id/append` `{values:[...]}` 或 `{value:v}` | 逐值/批量追加 |
| GET | `/summaries/:id/variance` | 两种方差（含归一口径标注） |
| POST | `/summaries/:id/explain` `{value}` | 解释更新前后 n/mean/M2 与本次贡献 |
| POST | `/summaries/:id/merge` `{otherId, newId?}` | 合并为新快照 |
| GET | `/summaries/:id/export` | 导出 JSON |
| POST | `/import` `{data, newId?}` | 导入（校验版本/零样本表示/有限值/M2） |
| GET | `/summaries/:id/operations` | 操作记录 |

请求幂等：追加时携带 `X-Request-Id` 头（或 body 的 `requestId`），相同 `(摘要, requestId)` 重试直接返回当前状态，不重复应用。

### 错误码

`NOT_FOUND`(404) · `ALREADY_EXISTS`(409) · `RULES_VERSION_MISMATCH`(409) · `NON_FINITE_VALUE`(422) · `VALUE_OUT_OF_RANGE`(422) · `INVALID_SUMMARY`(422) · `INVALID_IMPORT`(422) · `EMPTY_BATCH`/`BATCH_TOO_LARGE`/`COUNT_LIMIT`/`BAD_REQUEST`(400)

## CLI

```powershell
node dist/cli.js create s1
node dist/cli.js add s1 1 2 3
node dist/cli.js variance s1
node dist/cli.js explain s1 4
node dist/cli.js create s2; node dist/cli.js add s2 10 20
node dist/cli.js merge s1 s2 s3
node dist/cli.js export s3 > s3.json
node dist/cli.js import s3.json s4
node dist/cli.js ops s1
node dist/cli.js serve --port 8080
```

## 演示输出（`npm run demo`）

演示 1 `[1,2,3]` 逐步统计表：

| 步骤 | 值 | n | mean | M2 | 总体方差 M2/n | 样本方差 M2/(n-1) |
|---|---|---|---|---|---|---|
| 0 | - | 0 | 未定义 | 0 | 未定义 | 未定义 |
| 1 | 1 | 1 | 1 | 0 | 0 | 未定义 |
| 2 | 2 | 2 | 1.5 | 0.5 | 0.25 | 0.5 |
| 3 | 3 | 3 | 2 | 2 | 0.666… (=2/3) | 1 |

演示 2 `[1e12+4, 1e12+7, 1e12+13]`：Welford 样本方差 = 21（精确），朴素平方和公式 = 0（灾难性抵消）。

演示 3 分批 `[10,20,30]` 与 `[1000000,1000001]` 合并 vs 直接处理：容差内一致（本例相对误差为 0，但不保证逐位结合性）。

## 测试

`npm test` 覆盖：小整数流与精确和/平方和核对、常量流、负数、空摘要、单样本、极小波动（1e12 附近）、均值相距较大的合并、合并 vs 直接容差一致、来源不可变、自合并多重集语义、请求幂等、批次失败回滚、版本不一致拒绝、导入校验、重启一致性、HTTP 端到端。

## 目录结构

```
src/welford.ts   核心算法（更新/合并/校验/方差）
src/store.ts     SQLite 持久化（事务、操作记录、幂等键）
src/service.ts   业务服务层
src/server.ts    HTTP API
src/cli.ts       命令行
src/demo.ts      演示脚本
test/            node:test 测试
data/            SQLite 数据目录
```
