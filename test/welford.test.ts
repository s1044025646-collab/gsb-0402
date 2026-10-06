import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  emptySummary, updateOne, updateBatch, merge,
  populationVariance, sampleVariance, validateImported, sanitizeM2,
  MAX_ABS_VALUE, MAX_BATCH,
} from "../src/welford";
import { Store } from "../src/store";

const TOL = 1e-12;
const close = (a: number, b: number, tol = TOL) =>
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} !~= ${b}`);
const throwsCode = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e: unknown) => (e as { code: string }).code === code);

function summarize(values: number[]) {
  return updateBatch(emptySummary(), values).summary;
}

test("1,2,3: mean=2, 总体方差=2/3, 样本方差=1", () => {
  const s = summarize([1, 2, 3]);
  assert.equal(s.n, 3);
  close(s.mean, 2);
  close(populationVariance(s)!, 2 / 3);
  close(sampleVariance(s)!, 1);
});

test("空摘要: 均值与两种方差均未定义（不返回 0）", () => {
  const s = emptySummary();
  assert.equal(populationVariance(s), null);
  assert.equal(sampleVariance(s), null);
});

test("单样本: 总体方差为 0，样本方差未定义", () => {
  const s = summarize([42]);
  assert.equal(populationVariance(s), 0);
  assert.equal(sampleVariance(s), null);
});

test("常量流方差为 0", () => {
  const s = summarize(Array(1000).fill(7.5));
  close(s.mean, 7.5);
  assert.equal(s.m2, 0);
  assert.equal(populationVariance(s), 0);
});

test("负数与小整数精确核对（和与平方和）", () => {
  const values = [-5, -3, 0, 2, 8, -1, 4];
  const s = summarize(values);
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const m2 = values.reduce((acc, x) => acc + (x - mean) ** 2, 0);
  close(s.mean, mean);
  close(s.m2, m2);
});

test("大基数小波动: 1e12 附近三个相邻值，方差不被抵消丢失", () => {
  const big = 1e12;
  const s = summarize([big, big + 1, big + 2]);
  close(s.mean, big + 1);
  close(populationVariance(s)!, 2 / 3, 1e-9);
  close(sampleVariance(s)!, 1, 1e-9);
});

test("极小波动", () => {
  const s = summarize([1, 1 + 1e-9, 1 - 1e-9]);
  close(s.mean, 1, 1e-6);
  assert.ok(s.m2 >= 0);
});

test("合并 = 直接处理（容差内），来源不可变", () => {
  const a = summarize([1, 2, 3]);
  const b = summarize([10, 20, 30, 40]);
  const aCopy = { ...a }, bCopy = { ...b };
  const m = merge(a, b);
  const direct = summarize([1, 2, 3, 10, 20, 30, 40]);
  assert.equal(m.n, 7);
  close(m.mean, direct.mean);
  close(m.m2, direct.m2);
  assert.deepEqual(a, aCopy);
  assert.deepEqual(b, bCopy);
});

test("两组均值相距较大的合并", () => {
  const a = summarize([1e12, 1e12 + 2]);
  const b = summarize([-1e12, -1e12 - 2]);
  const m = merge(a, b);
  const direct = summarize([1e12, 1e12 + 2, -1e12, -1e12 - 2]);
  close(m.mean, direct.mean);
  close(m.m2, direct.m2, 1e-9);
});

test("空摘要是合并单位元；自合并计数翻倍（多重集语义）", () => {
  const a = summarize([1, 2, 3]);
  assert.deepEqual(merge(a, emptySummary()), a);
  assert.deepEqual(merge(emptySummary(), a), a);
  const self = merge(a, a);
  assert.equal(self.n, 6);
  close(self.mean, 2);
  close(self.m2, 2 * a.m2);
});

test("版本不一致拒绝合并", () => {
  const a = summarize([1]);
  const b = { ...summarize([2]), version: "welford-v0" };
  throwsCode(() => merge(a, b), "VERSION_MISMATCH");
});

test("拒绝非有限值与超范围值", () => {
  throwsCode(() => updateOne(emptySummary(), NaN), "NON_FINITE");
  throwsCode(() => updateOne(emptySummary(), Infinity), "NON_FINITE");
  throwsCode(() => updateOne(emptySummary(), MAX_ABS_VALUE * 2), "VALUE_OUT_OF_RANGE");
  throwsCode(() => updateOne(emptySummary(), "x"), "INVALID_INPUT");
});

test("批次超限拒绝", () => {
  throwsCode(() => updateBatch(emptySummary(), new Array(MAX_BATCH + 1).fill(1)), "BATCH_TOO_LARGE");
});

test("M2 极小负值截零，明显负值抛 ILLEGAL_STATE", () => {
  assert.equal(sanitizeM2(-1e-15, 10, 1), 0);
  throwsCode(() => sanitizeM2(-1, 10, 1), "ILLEGAL_STATE");
  throwsCode(() => sanitizeM2(NaN, 10, 1), "ILLEGAL_STATE");
});

test("导入校验: 零样本规范表示、有限性、版本", () => {
  assert.deepEqual(validateImported({ n: 0, mean: 0, m2: 0, version: "welford-v1" }), {
    n: 0, mean: 0, m2: 0, version: "welford-v1",
  });
  throwsCode(() => validateImported({ n: 0, mean: 1, m2: 0, version: "welford-v1" }), "INVALID_INPUT");
  throwsCode(() => validateImported({ n: 2, mean: NaN, m2: 0, version: "welford-v1" }), "NON_FINITE");
  throwsCode(() => validateImported({ n: 2, mean: 0, m2: -5, version: "welford-v1" }), "ILLEGAL_STATE");
  throwsCode(() => validateImported({ n: 1, mean: 0, m2: 0, version: "v9" }), "VERSION_MISMATCH");
});

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "welford-"));
  return new Store(path.join(dir, "t.db"));
}

test("持久化: 重启后继续更新与直接运行一致", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "welford-"));
  const db = path.join(dir, "t.db");
  const s1 = new Store(db);
  s1.create("x");
  const half = updateBatch(emptySummary(), [1, 2, 3]).summary;
  s1.applyUpdate("x", half, "append", undefined, {}, {});
  s1.close();
  const s2 = new Store(db);
  const cur = s2.get("x");
  const rest = updateBatch(cur, [4, 5, 6]).summary;
  s2.applyUpdate("x", rest, "append", undefined, {}, {});
  const finalS = s2.get("x");
  s2.close();
  const direct = summarize([1, 2, 3, 4, 5, 6]);
  assert.deepEqual(finalS, direct);
});

test("批次含非法值整体拒绝，不保留前半批", () => {
  const store = tmpStore();
  store.create("b");
  store.applyUpdate("b", summarize([1, 2]), "append", undefined, {}, {});
  const before = store.get("b");
  throwsCode(() => updateBatch(before, [3, 4, NaN, 5]), "NON_FINITE");
  assert.deepEqual(store.get("b"), before);
  store.close();
});

test("请求幂等: 相同 requestId 重放返回原结果且不重复计数", () => {
  const store = tmpStore();
  store.create("i");
  const r1 = updateBatch(emptySummary(), [1, 2, 3]);
  store.applyUpdate("i", r1.summary, "append", "req-1", {}, { ok: 1 });
  const replay = store.findOpByRequestId("i", "req-1");
  assert.ok(replay);
  assert.equal(JSON.parse(replay!.result).ok, 1);
  assert.equal(store.get("i").n, 3);
  store.close();
});

test("失败回滚: 事务中出错不留下半写状态", () => {
  const store = tmpStore();
  store.create("r");
  throwsCode(() => store.create("r"), "CONFLICT");
  assert.equal(store.get("r").n, 0);
  store.close();
});
