import { test } from "node:test";
import * as assert from "node:assert/strict";
import {
  emptySummary, update, updateBatch, merge,
  populationVariance, sampleVariance, validateSummary,
  WelfordError, MAX_ABS_VALUE,
} from "../src/welford";
import { Service } from "../src/service";
import { Store } from "../src/store";
import { createServer } from "../src/server";
import { AddressInfo } from "node:net";

const TOL = 1e-12;
function close(a: number, b: number, tol = TOL): void {
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} !~= ${b}`);
}

// 精确核对：小整数流用精确和与平方和对比
function exactCheck(values: number[]): void {
  let s = emptySummary();
  for (const v of values) s = update(s, v).next;
  const n = values.length;
  const sum = values.reduce((a, b) => a + b, 0);
  const sumSq = values.reduce((a, b) => a + b * b, 0);
  const mean = sum / n;
  const m2 = sumSq - (sum * sum) / n; // 小整数下双精度精确
  close(s.mean, mean);
  close(s.m2, m2);
}

test("演示用例: [1,2,3] mean=2, 总体方差=2/3, 样本方差=1", () => {
  const { summary } = updateBatch(emptySummary(), [1, 2, 3]);
  assert.equal(summary.n, 3);
  assert.equal(summary.mean, 2);
  close(populationVariance(summary)!, 2 / 3);
  assert.equal(sampleVariance(summary), 1);
});

test("小整数流与精确和/平方和核对", () => {
  exactCheck([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  exactCheck([-5, -3, -1, 1, 3, 5]);
  exactCheck([7]);
});

test("常量流方差为零", () => {
  const { summary } = updateBatch(emptySummary(), [3.5, 3.5, 3.5, 3.5]);
  assert.equal(summary.m2, 0);
  assert.equal(populationVariance(summary), 0);
  assert.equal(sampleVariance(summary), 0);
});

test("负数流", () => {
  const { summary } = updateBatch(emptySummary(), [-4, -2, 0, 2, 4]);
  assert.equal(summary.mean, 0);
  assert.equal(sampleVariance(summary), 10);
});

test("空摘要: 均值与两种方差均未定义(null)", () => {
  const s = emptySummary();
  assert.equal(populationVariance(s), null);
  assert.equal(sampleVariance(s), null);
});

test("单样本: 总体方差为 0，样本方差未定义", () => {
  const s = update(emptySummary(), 42).next;
  assert.equal(populationVariance(s), 0);
  assert.equal(sampleVariance(s), null);
});

test("极小波动: 1e12 附近的相邻值保留小方差", () => {
  const big = 1e12;
  const { summary } = updateBatch(emptySummary(), [big + 4, big + 7, big + 13]);
  close(sampleVariance(summary)!, 21, 1e-9);
  // 朴素公式在此场景完全失效
  const sum = (big + 4) + (big + 7) + (big + 13);
  const sumSq = (big + 4) ** 2 + (big + 7) ** 2 + (big + 13) ** 2;
  const naive = sumSq / 3 - (sum / 3) ** 2;
  assert.ok(Math.abs(naive - 14) > 1, "朴素公式应出现灾难性抵消");
});

test("合并: 两组均值相距较大，与直接处理容差内一致", () => {
  const va = [10, 20, 30];
  const vb = [1e6, 1e6 + 1];
  const a = updateBatch(emptySummary(), va).summary;
  const b = updateBatch(emptySummary(), vb).summary;
  const m = merge(a, b);
  const direct = updateBatch(emptySummary(), [...va, ...vb]).summary;
  assert.equal(m.n, 5);
  close(m.mean, direct.mean);
  close(m.m2, direct.m2, 1e-9);
});

test("合并: 空摘要是单位元", () => {
  const a = updateBatch(emptySummary(), [1, 2, 3]).summary;
  const m = merge(a, emptySummary());
  assert.deepEqual(m, a);
  assert.deepEqual(merge(emptySummary(), a), a);
});

test("合并: 自合并计数翻倍（多重集语义，非幂等）", () => {
  const a = updateBatch(emptySummary(), [1, 2, 3]).summary;
  const m = merge(a, a);
  assert.equal(m.n, 6);
  const direct = updateBatch(emptySummary(), [1, 2, 3, 1, 2, 3]).summary;
  close(m.m2, direct.m2);
});

test("合并不修改来源", () => {
  const a = updateBatch(emptySummary(), [1, 2]).summary;
  const b = updateBatch(emptySummary(), [3, 4]).summary;
  const snap = { ...a };
  merge(a, b);
  assert.deepEqual(a, snap);
});

test("拒绝非有限值与超范围值", () => {
  assert.throws(() => update(emptySummary(), NaN), WelfordError);
  assert.throws(() => update(emptySummary(), Infinity), WelfordError);
  assert.throws(() => update(emptySummary(), MAX_ABS_VALUE * 2), WelfordError);
});

test("非法 M2 状态拒绝，极小负值截零", () => {
  assert.throws(() => validateSummary({ n: 3, mean: 0, m2: -1 }), /M2/);
  const s = { n: 3, mean: 1e8, m2: -1e-12 * 3 * 1e16 * 0.5 };
  validateSummary(s); // 噪声范围内 → 截为 0
  assert.equal(s.m2, 0);
});

test("零样本导入必须 mean=0 且 M2=0", () => {
  assert.throws(() => validateSummary({ n: 0, mean: 1, m2: 0 }), WelfordError);
  validateSummary({ n: 0, mean: 0, m2: 0 });
});

test("批量含非法值整体拒绝，不落前半批", () => {
  const svc = new Service(new Store(":memory:"));
  svc.create("s");
  svc.append("s", [1, 2]);
  assert.throws(() => svc.append("s", [3, NaN, 4]), WelfordError);
  assert.equal(svc.get("s").n, 2); // 3 未落库
});

test("请求幂等: 相同 requestId 不重复应用", () => {
  const svc = new Service(new Store(":memory:"));
  svc.create("s");
  svc.append("s", [1, 2, 3], "req-1");
  const again = svc.append("s", [1, 2, 3], "req-1");
  assert.equal(again.summary.n, 3); // 而非 6
});

test("合并版本不一致被拒绝", () => {
  const svc = new Service(new Store(":memory:"));
  svc.create("a");
  svc.create("b");
  (svc.store as any).db.prepare("UPDATE summaries SET rules_version=99 WHERE id='b'").run();
  assert.throws(() => svc.merge("a", "b"), /版本/);
});

test("导入校验: 拒绝非法与版本不符", () => {
  const svc = new Service(new Store(":memory:"));
  assert.throws(() => svc.import({ rulesVersion: 1, n: 2, mean: 0, m2: -5 }), WelfordError);
  assert.throws(() => svc.import({ rulesVersion: 99, n: 0, mean: 0, m2: 0 }), WelfordError);
  const ok = svc.import({ rulesVersion: 1, n: 3, mean: 2, m2: 2 }, "imp");
  assert.equal(ok.n, 3);
});

test("重启后继续更新与直接运行一致", () => {
  const svc1 = new Service(new Store(":memory:"));
  svc1.create("s");
  svc1.append("s", [1, 2, 3]);
  const snap = svc1.export("s") as any;
  // 模拟重启：新 Service 导入快照后继续
  const svc2 = new Service(new Store(":memory:"));
  svc2.import(snap, "s");
  svc2.append("s", [4, 5]);
  const direct = updateBatch(emptySummary(), [1, 2, 3, 4, 5]).summary;
  const got = svc2.get("s");
  assert.equal(got.n, direct.n);
  assert.equal(got.mean, direct.mean);
  assert.equal(got.m2, direct.m2);
});

test("HTTP API 端到端", async () => {
  const svc = new Service(new Store(":memory:"));
  const server = createServer(svc);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  const base = `http://localhost:${port}`;
  const post = async (p: string, body: any, headers: any = {}) => {
    const res = await fetch(base + p, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  };
  const get = async (p: string) => {
    const res = await fetch(base + p);
    return { status: res.status, body: await res.json() as any };
  };

  assert.equal((await post("/summaries", { id: "api1" })).status, 201);
  const app = await post("/summaries/api1/append", { values: [1, 2, 3] });
  assert.equal(app.status, 200);
  assert.equal(app.body.summary.n, 3);
  const v = await get("/summaries/api1/variance");
  assert.equal(v.body.mean, 2);
  assert.equal(v.body.sampleVariance, 1);
  // 非法值 → 422 且整体回滚
  const bad = await post("/summaries/api1/append", { values: [4, "x"] });
  assert.equal(bad.status, 422);
  assert.equal((await get("/summaries/api1")).body.n, 3);
  // 幂等
  await post("/summaries/api1/append", { values: [4] }, { "X-Request-Id": "r1" });
  await post("/summaries/api1/append", { values: [4] }, { "X-Request-Id": "r1" });
  assert.equal((await get("/summaries/api1")).body.n, 4);
  // explain
  const ex = await post("/summaries/api1/explain", { value: 5 });
  assert.equal(ex.body.before.n, 4);
  assert.equal(ex.body.after.n, 5);
  // merge
  await post("/summaries", { id: "api2" });
  await post("/summaries/api2/append", { values: [10, 20] });
  const mg = await post("/summaries/api1/merge", { otherId: "api2", newId: "api3" });
  assert.equal(mg.status, 201);
  assert.equal(mg.body.n, 6);
  assert.equal((await get("/summaries/api2")).body.n, 2); // 来源不可变
  // export/import
  const exp = await get("/summaries/api3/export");
  const imp = await post("/import", { data: exp.body, newId: "api4" });
  assert.equal(imp.status, 201);
  assert.equal(imp.body.n, 6);
  server.close();
});
