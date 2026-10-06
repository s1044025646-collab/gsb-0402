# Welford 在线方差与分批摘要合并解释后端

仅后端（API + CLI）。TypeScript + Node.js + SQLite（Node 内置 `node:sqlite`，无原生编译依赖），Windows 本地运行，不需要 Docker / WSL / 外部服务。

## 功能

- 单变量数值流的在线均值与方差：逐个或按批追加有限实数，持久保存摘要 `(n, mean, M2)`。
- 查询总体方差 `M2/n` 与样本方差 `M2/(n-1)`，响应中标注归一口径（`varianceDenominator`）。
- 两个批次摘要按标准公式合并为新快照；空摘要为单位元；来源不被修改。
- 每次更新给出前后 `n / mean / M2` 与本次贡献（`delta`、`delta2`、`m2Delta`）的解释。
- 导入 / 导出摘要、规则版本查询与比较、操作记录审计、请求幂等。

## 数值规则（公开承诺）

- **Welford 稳定更新**：`delta = x - mean`；`mean += delta / n`；`M2 += delta * (x - mean_new)`。不使用 `sum(x²)/n - mean²` 的朴素公式——大基数小波动会发生灾难性抵消（见演示，`1e12` 附近朴素公式给出 `-134217728` 的负方差）。
- **精度**：IEEE 754 双精度。不承诺任意排列和分批方式逐位相同（浮点加法不具结合性），只在公开容差内一致。
- **M2 负值规则**：M2 理论非负。若出现相对量级 ≤ `1e-12 * max(1, n·mean²)` 的极小负值，截断为 0；更负或 NaN 视为明显非法状态，抛出 `ILLEGAL_STATE`，绝不静默截零。
- **未定义语义**：空摘要的均值与两种方差均为 `null`（未定义）；单样本总体方差为 0、样本方差为 `null`；不会把这些情形返回成数字 0。
- **限制**：`|x| ≤ 1e15`，累计 `n ≤ 2^53-1`，单批 ≤ 1,000,000 个值；拒绝 NaN / ±Infinity。
- **合并公式**：`n = nA+nB`；`delta = meanB - meanA`；`mean = meanA + delta·nB/n`；`M2 = M2A + M2B + delta²·nA·nB/n`（含两组均值分离的交叉项，不是两份方差的平均）。
- **多重集语义**：输入按多重集处理。重复合并同一来源会重复计样本；自合并计数翻倍（`merge(a,a)` 的 `n = 2·nA`），不具集合并集的幂等性。这与“请求重试幂等”是两回事：带相同 `requestId` 的重放请求返回首次结果、不重复生效。
- **版本**：摘要带规则版本（当前 `welford-v1`），版本不一致拒绝合并（`VERSION_MISMATCH`）。
- **导入**：校验零样本规范表示（`n=0, mean=0, m2=0`）、数量范围、有限性与 M2 合法性。注意：仅凭 `(n, mean, M2)` 三个统计量**无法验证**其来自哪份真实原始数据。
- **持久化**：SQLite 单事务原子写入摘要与操作记录；批次含非法值整体拒绝，不保留前半批；重启后继续更新与相同顺序直接运行一致。

## 错误码

`INVALID_INPUT` `NON_FINITE` `VALUE_OUT_OF_RANGE` `BATCH_TOO_LARGE` `COUNT_OUT_OF_RANGE` `NOT_FOUND` `ILLEGAL_STATE` `VERSION_MISMATCH` `CONFLICT`

错误响应形如 `{"error":{"code":"...","message":"..."}}`。

## 命令

```powershell
npm install      # 安装 devDependencies（typescript）
npm run build    # 编译到 dist/
npm test         # 构建并运行全部测试
npm start        # 启动 HTTP 服务（默认 127.0.0.1 + 空闲端口；PORT=8080 指定）
npm run demo     # 数值演示
npm run cli -- <命令>   # 或 node dist/src/cli.js <命令>
```

数据目录为项目内 `data/`（可用环境变量 `WELFORD_DB` 覆盖数据库路径）。

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/version` | 规则版本、限制与精度说明 |
| POST | `/summaries` | 创建 `{id?, requestId?}` |
| GET | `/summaries` / `/summaries/:id` | 列表 / 查询（含两种方差） |
| POST | `/summaries/:id/values` | 追加 `{values:[...], requestId?}`，返回末次更新解释 |
| GET | `/summaries/:id/explanation` | 最近一次更新解释 |
| GET | `/summaries/:id/ops` | 操作记录 |
| GET | `/summaries/:id/export` | 导出摘要 |
| POST | `/import` | 导入 `{id, summary, requestId?}` |
| POST | `/merge` | 合并 `{a, b, id?, requestId?}` 为新快照 |
| GET | `/compare?a=&b=` | 比较两者规则版本 |

## CLI

```
node dist/src/cli.js create <id>            创建空摘要
node dist/src/cli.js add <id> <v1> [v2...]  逐值/批量追加
node dist/src/cli.js get <id>               查询均值与两种方差
node dist/src/cli.js explain <id>           最近一次更新解释
node dist/src/cli.js merge <a> <b> [newId]  合并为新快照（来源不变）
node dist/src/cli.js export <id>            导出摘要 JSON
node dist/src/cli.js import <id> <file>     导入摘要
node dist/src/cli.js compare <a> <b>        版本比较
node dist/src/cli.js list / version
```

## 演示输出（`npm run demo`）

数据 `1, 2, 3` 的逐步统计表：

```
x  n  mean  M2   总体方差(M2/n)      样本方差(M2/(n-1))
1  1  1     0    0                   未定义
2  2  1.5   0.5  0.25                0.5
3  3  2     2    0.6666666666666666  1
```

大基数小波动 `1e12, 1e12+1, 1e12+2`：Welford 得总体方差 `2/3`、样本方差 `1`；朴素平方和公式在同一数据上给出 `-134217728`（灾难性抵消）。

合并 `{1,2,3}` 与 `{4,5,6}` 得 `n=6, mean=3.5, M2=17.5`，与直接处理完全一致。

## 测试

`npm test` 运行 19 个用例：小整数精确核对（和与平方和）、浮点容差比较、常量流、负数、空摘要、单样本、极小波动、大基数小波动、均值相距较大的两组合并、合并与直接处理容差一致、来源不可变、空摘要单位元、自合并翻倍、版本拒绝、请求幂等、批次失败回滚、重启一致性、导入校验、M2 负值规则。

## 限制

- 双精度浮点：不同排列 / 分批方式结果只在容差内一致，不逐位相同。
- 合并是多重集语义，不是集合并集。
- 仅凭 `(n, mean, M2)` 无法回溯或验证原始数据。
- 不支持删除、滑动窗口、回归或分布拟合（按设计）。
