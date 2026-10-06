import { emptySummary, updateBatch, merge, populationVariance, sampleVariance } from "./welford";

function table(title: string, values: number[]) {
  console.log(`\n== ${title} ==`);
  console.log("x\t\tn\tmean\t\tM2\t\t总体方差(M2/n)\t样本方差(M2/(n-1))");
  let s = emptySummary();
  let sum = 0;
  let sumSq = 0;
  for (const x of values) {
    const r = updateBatch(s, [x]);
    s = r.summary;
    sum += x;
    sumSq += x * x;
    const naive = s.n > 0 ? sumSq / s.n - (sum / s.n) ** 2 : NaN;
    console.log(
      `${x}\t\t${s.n}\t${s.mean}\t${s.m2}\t${populationVariance(s) ?? "未定义"}\t\t${sampleVariance(s) ?? "未定义"}` +
        `\t(朴素公式: ${naive})`
    );
  }
  return s;
}

// 演示 1：1, 2, 3 -> mean=2, 总体方差=2/3, 样本方差=1
const a = table("数据 1, 2, 3", [1, 2, 3]);
console.log(`\n期望: mean=2, 总体方差=${2 / 3}, 样本方差=1`);

// 演示 2：1e12, 1e12+1, 1e12+2 —— 朴素平方和公式在大基数上严重抵消
const big = 1e12;
table("大基数小波动: 1e12, 1e12+1, 1e12+2", [big, big + 1, big + 2]);
console.log("说明: 朴素公式 sum(x^2)/n - mean^2 在 1e12 量级上因灾难性抵消得到错误甚至负值；Welford 稳定。");

// 演示 3：合并与直接处理一致
const b = updateBatch(emptySummary(), [4, 5, 6]).summary;
const direct = updateBatch(emptySummary(), [1, 2, 3, 4, 5, 6]).summary;
const merged = merge(a, b);
console.log("\n== 合并 {1,2,3} 与 {4,5,6} ==");
console.log("合并结果:", merged);
console.log("直接处理:", direct);
console.log(
  `容差内一致: |dMean|=${Math.abs(merged.mean - direct.mean)}, |dM2|=${Math.abs(merged.m2 - direct.m2)}`
);
