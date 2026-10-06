/** 演示脚本：
 *  1) [1,2,3]：mean=2，总体方差=2/3，样本方差=1，逐步统计表
 *  2) 1e12 附近的三个相邻值：朴素平方和公式丢光小方差，Welford 保留
 *  3) 分批合并与一次性处理在容差内一致
 */
import { emptySummary, update, merge, populationVariance, sampleVariance, Summary } from "./welford";

function fmt(x: number | null): string {
  return x === null ? "未定义" : Number.isInteger(x) ? String(x) : x.toPrecision(15);
}

function table(title: string, values: number[]): Summary {
  console.log(`\n== ${title} ==`);
  console.log("步骤 | 值 | n | mean | M2 | 总体方差 M2/n | 样本方差 M2/(n-1)");
  let s = emptySummary();
  console.log(`0 | - | 0 | 未定义 | 0 | 未定义 | 未定义`);
  values.forEach((v, i) => {
    const r = update(s, v);
    s = r.next;
    console.log(
      `${i + 1} | ${v} | ${s.n} | ${fmt(s.mean)} | ${fmt(s.m2)} | ${fmt(populationVariance(s))} | ${fmt(sampleVariance(s))}`
    );
  });
  return s;
}

// 演示 1
const s123 = table("演示 1: [1, 2, 3]", [1, 2, 3]);
console.log(`结论: mean=${fmt(s123.mean)}, 总体方差=${fmt(populationVariance(s123))} (=2/3), 样本方差=${fmt(sampleVariance(s123))} (=1)`);

// 演示 2: 大基数小波动
const big = 1e12;
const vals = [big + 4, big + 7, big + 13]; // 均值 big+8，样本方差 21
const sBig = table("演示 2: [1e12+4, 1e12+7, 1e12+13]", vals);
console.log(`Welford: 样本方差 = ${fmt(sampleVariance(sBig))} (精确值 21)`);
// 朴素公式 E[x^2]-E[x]^2 对比
const n = vals.length;
const sum = vals.reduce((a, b) => a + b, 0);
const sumSq = vals.reduce((a, b) => a + b * b, 0);
const naive = sumSq / n - (sum / n) ** 2;
console.log(`朴素平方和公式: 总体方差 = ${fmt(naive)} (精确值 14，灾难性抵消)`);

// 演示 3: 合并 vs 直接
const a = table("演示 3a: 批次 A [10, 20, 30]", [10, 20, 30]);
const b = table("演示 3b: 批次 B [1000000, 1000001]", [1000000, 1000001]);
const m = merge(a, b);
let direct = emptySummary();
for (const v of [10, 20, 30, 1000000, 1000001]) direct = update(direct, v).next;
console.log(`\n合并结果: n=${m.n}, mean=${fmt(m.mean)}, M2=${fmt(m.m2)}`);
console.log(`直接处理: n=${direct.n}, mean=${fmt(direct.mean)}, M2=${fmt(direct.m2)}`);
console.log(`M2 相对误差: ${Math.abs(m.m2 - direct.m2) / direct.m2} (容差内一致，非逐位相同)`);
