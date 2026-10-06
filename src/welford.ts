/**
 * Welford 在线均值/方差核心算法。
 *
 * 数值规则版本：RULES_VERSION。不同版本的摘要禁止合并。
 *
 * 精度说明：全部使用 IEEE-754 双精度。Welford 更新是数值稳定的，
 * 但不保证任意排列 / 分批方式下结果逐位相同（浮点加法不可结合）。
 */

export const RULES_VERSION = 1;

/** 允许的样本绝对值上限（|x| <= MAX_ABS_VALUE） */
export const MAX_ABS_VALUE = 1e15;
/** 累计样本数上限 */
export const MAX_COUNT = 2 ** 53 - 1;
/** 单次批量追加的最大值个数 */
export const MAX_BATCH_SIZE = 1_000_000;

/** M2 理论上非负；浮点误差可能造成极小负值。
 *  规则：若 M2 < 0 且 |M2| <= M2_NEG_TOLERANCE * max(1, n * mean^2)，
 *  视为浮点噪声并截为 0；否则判定为非法状态并拒绝。 */
export const M2_NEG_TOLERANCE = 1e-12;

export interface Summary {
  n: number;
  mean: number;
  m2: number;
}

export class WelfordError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "WelfordError";
  }
}

export function emptySummary(): Summary {
  return { n: 0, mean: 0, m2: 0 };
}

export function isEmpty(s: Summary): boolean {
  return s.n === 0;
}

export function validateValue(x: unknown): number {
  if (typeof x !== "number" || !Number.isFinite(x)) {
    throw new WelfordError("NON_FINITE_VALUE", `值必须是有限实数，收到: ${String(x)}`);
  }
  if (Math.abs(x) > MAX_ABS_VALUE) {
    throw new WelfordError("VALUE_OUT_OF_RANGE", `|x| 不得超过 ${MAX_ABS_VALUE}，收到: ${x}`);
  }
  return x;
}

/** 校验一个摘要状态是否合法（用于导入与合并前检查）。 */
export function validateSummary(s: Summary): void {
  if (!Number.isInteger(s.n) || s.n < 0) {
    throw new WelfordError("INVALID_SUMMARY", `n 必须是非负整数，收到: ${s.n}`);
  }
  if (s.n > MAX_COUNT) {
    throw new WelfordError("COUNT_LIMIT", `n 超过上限 ${MAX_COUNT}`);
  }
  if (s.n === 0) {
    // 零样本表示必须规范化：mean = 0, m2 = 0
    if (s.mean !== 0 || s.m2 !== 0) {
      throw new WelfordError("INVALID_SUMMARY", "空摘要(n=0)必须满足 mean=0 且 M2=0");
    }
    return;
  }
  if (!Number.isFinite(s.mean)) {
    throw new WelfordError("INVALID_SUMMARY", `mean 必须有限，收到: ${s.mean}`);
  }
  if (!Number.isFinite(s.m2)) {
    throw new WelfordError("INVALID_SUMMARY", `M2 必须有限，收到: ${s.m2}`);
  }
  checkM2(s);
}

/** M2 负值处理：极小负值（浮点噪声）截为 0，明显非法则拒绝。 */
export function checkM2(s: Summary): void {
  if (s.m2 >= 0) return;
  const scale = Math.max(1, s.n * s.mean * s.mean);
  if (Math.abs(s.m2) <= M2_NEG_TOLERANCE * scale) {
    s.m2 = 0;
    return;
  }
  throw new WelfordError(
    "INVALID_SUMMARY",
    `M2 明显为负 (${s.m2})，超出浮点噪声容差，状态非法`
  );
}

export interface UpdateExplanation {
  before: Summary;
  after: Summary;
  value: number;
  delta: number;      // x - meanBefore
  delta2: number;     // x - meanAfter
  contribution: number; // delta * delta2，即本次对 M2 的贡献
}

/** Welford 单值更新。返回新摘要与解释；不修改入参。 */
export function update(s: Summary, x: number): { next: Summary; explanation: UpdateExplanation } {
  validateSummary(s);
  validateValue(x);
  if (s.n + 1 > MAX_COUNT) {
    throw new WelfordError("COUNT_LIMIT", `n 将超过上限 ${MAX_COUNT}`);
  }
  const n1 = s.n + 1;
  const delta = x - s.mean;
  const mean1 = s.mean + delta / n1;
  const delta2 = x - mean1;
  const next: Summary = { n: n1, mean: mean1, m2: s.m2 + delta * delta2 };
  checkM2(next);
  return {
    next,
    explanation: {
      before: { ...s },
      after: { ...next },
      value: x,
      delta,
      delta2,
      contribution: delta * delta2,
    },
  };
}

export interface BatchResult {
  summary: Summary;
  explanations: UpdateExplanation[];
}

/** 批量更新：先在内存中整体计算，任一值非法则整体拒绝（调用方不落库即实现回滚）。 */
export function updateBatch(s: Summary, values: number[]): BatchResult {
  if (!Array.isArray(values) || values.length === 0) {
    throw new WelfordError("EMPTY_BATCH", "批量追加至少需要一个值");
  }
  if (values.length > MAX_BATCH_SIZE) {
    throw new WelfordError("BATCH_TOO_LARGE", `单批最多 ${MAX_BATCH_SIZE} 个值`);
  }
  // 先校验全部值，保证整体拒绝而不处理前半批
  for (const v of values) validateValue(v);
  let cur: Summary = { ...s };
  const explanations: UpdateExplanation[] = [];
  for (const v of values) {
    const r = update(cur, v);
    cur = r.next;
    explanations.push(r.explanation);
  }
  return { summary: cur, explanations };
}

/**
 * 标准摘要合并（Chan et al. 推广）：
 *   n = nA + nB
 *   mean = meanA + (meanB - meanA) * nB / n
 *   M2 = M2A + M2B + (meanB - meanA)^2 * nA * nB / n
 * 空摘要是合并单位元。输入视为多重集：自合并计数翻倍，不具幂等性。
 */
export function merge(a: Summary, b: Summary): Summary {
  validateSummary(a);
  validateSummary(b);
  if (a.n === 0) return { ...b };
  if (b.n === 0) return { ...a };
  const n = a.n + b.n;
  if (n > MAX_COUNT) {
    throw new WelfordError("COUNT_LIMIT", `合并后 n 超过上限 ${MAX_COUNT}`);
  }
  const delta = b.mean - a.mean;
  const mean = a.mean + (delta * b.n) / n;
  const m2 = a.m2 + b.m2 + (delta * delta * a.n * b.n) / n;
  const out: Summary = { n, mean, m2 };
  checkM2(out);
  return out;
}

/** 总体方差 M2/n；空摘要未定义返回 null。单样本为 0。 */
export function populationVariance(s: Summary): number | null {
  if (s.n === 0) return null;
  return s.m2 / s.n;
}

/** 样本方差 M2/(n-1)；n < 2 未定义返回 null。 */
export function sampleVariance(s: Summary): number | null {
  if (s.n < 2) return null;
  return s.m2 / (s.n - 1);
}
