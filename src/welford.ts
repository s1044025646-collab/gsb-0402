import { err } from "./errors";

/** 数值规则版本：摘要之间合并时版本必须一致。 */
export const RULES_VERSION = "welford-v1";

/** 允许的样本绝对值上限（|x| <= MAX_ABS_VALUE）。 */
export const MAX_ABS_VALUE = 1e15;
/** 累计样本数上限。 */
export const MAX_N = Number.MAX_SAFE_INTEGER;
/** 单批追加的最大值个数。 */
export const MAX_BATCH = 1_000_000;

/**
 * M2 极小负值处理规则（公开）：
 * M2 理论上非负。因浮点舍入，可能出现 |m2| 相对量级不超过
 * M2_NEG_REL_TOL * max(1, n * mean^2) 的极小负值，此时截断为 0；
 * 更负的值视为明显非法状态，抛出 ILLEGAL_STATE，绝不静默截零。
 */
export const M2_NEG_REL_TOL = 1e-12;

export interface Summary {
  n: number;
  mean: number;
  m2: number;
  version: string;
}

export interface UpdateExplanation {
  before: { n: number; mean: number; m2: number };
  after: { n: number; mean: number; m2: number };
  contribution: {
    x: number;
    delta: number; // x - meanBefore
    delta2: number; // x - meanAfter
    meanDelta: number; // meanAfter - meanBefore
    m2Delta: number; // delta * delta2，本次对 M2 的贡献
  };
}

export function emptySummary(): Summary {
  return { n: 0, mean: 0, m2: 0, version: RULES_VERSION };
}

export function checkValue(x: unknown): number {
  if (typeof x !== "number") throw err.invalidInput(`值必须是数字，收到: ${typeof x}`);
  if (!Number.isFinite(x)) throw err.nonFinite(`拒绝非有限值: ${x}`);
  if (Math.abs(x) > MAX_ABS_VALUE)
    throw err.valueOutOfRange(`|x| 超过上限 ${MAX_ABS_VALUE}: ${x}`);
  return x;
}

/** 校验并修复 M2 的浮点负值；明显非法则抛错。 */
export function sanitizeM2(m2: number, n: number, mean: number): number {
  if (Number.isNaN(m2)) throw err.illegalState("M2 为 NaN，摘要状态非法");
  if (m2 < 0) {
    const scale = Math.max(1, n * mean * mean);
    if (m2 >= -M2_NEG_REL_TOL * scale) return 0;
    throw err.illegalState(
      `M2 为明显负值 (${m2})，超出浮点容差，摘要状态非法`
    );
  }
  return m2;
}

/** Welford 单值稳定更新。返回新摘要与解释。 */
export function updateOne(s: Summary, xRaw: unknown): { summary: Summary; explanation: UpdateExplanation } {
  const x = checkValue(xRaw);
  if (s.n + 1 > MAX_N) throw err.countOutOfRange(`样本数超过上限 ${MAX_N}`);
  const n1 = s.n + 1;
  const delta = x - s.mean;
  const mean1 = s.mean + delta / n1;
  const delta2 = x - mean1;
  const m2 = sanitizeM2(s.m2 + delta * delta2, n1, mean1);
  const summary: Summary = { n: n1, mean: mean1, m2, version: s.version };
  return {
    summary,
    explanation: {
      before: { n: s.n, mean: s.mean, m2: s.m2 },
      after: { n: n1, mean: mean1, m2 },
      contribution: {
        x,
        delta,
        delta2,
        meanDelta: mean1 - s.mean,
        m2Delta: delta * delta2,
      },
    },
  };
}

/** 批量更新（全部校验通过后才应用；由调用方保证事务）。 */
export function updateBatch(
  s: Summary,
  values: unknown[]
): { summary: Summary; explanations: UpdateExplanation[] } {
  if (!Array.isArray(values)) throw err.invalidInput("values 必须是数组");
  if (values.length === 0) throw err.invalidInput("values 不能为空数组");
  if (values.length > MAX_BATCH)
    throw err.batchTooLarge(`单批最多 ${MAX_BATCH} 个值，收到 ${values.length}`);
  if (s.n + values.length > MAX_N)
    throw err.countOutOfRange(`样本数将超过上限 ${MAX_N}`);
  // 先整体校验，再逐个应用，保证批次原子性。
  values.forEach(checkValue);
  let cur = s;
  const explanations: UpdateExplanation[] = [];
  for (const x of values) {
    const r = updateOne(cur, x);
    cur = r.summary;
    explanations.push(r.explanation);
  }
  return { summary: cur, explanations };
}

/**
 * 标准摘要合并（Chan 公式）：
 * n = nA + nB；mean = meanA + delta * nB / n；M2 = M2A + M2B + delta^2 * nA*nB/n。
 * 空摘要是单位元；不修改来源；多重集语义，自合并计数翻倍。
 */
export function merge(a: Summary, b: Summary): Summary {
  if (a.version !== b.version)
    throw err.versionMismatch(
      `数值规则版本不一致，拒绝合并: ${a.version} vs ${b.version}`
    );
  if (a.n + b.n > MAX_N) throw err.countOutOfRange(`合并后样本数超过上限 ${MAX_N}`);
  if (a.n === 0) return { ...b };
  if (b.n === 0) return { ...a };
  const n = a.n + b.n;
  const delta = b.mean - a.mean;
  const mean = a.mean + (delta * b.n) / n;
  const m2 = sanitizeM2(a.m2 + b.m2 + (delta * delta * a.n * b.n) / n, n, mean);
  return { n, mean, m2, version: a.version };
}

/** 总体方差 M2/n；n=0 未定义。 */
export function populationVariance(s: Summary): number | null {
  if (s.n === 0) return null;
  return s.m2 / s.n;
}

/** 样本方差 M2/(n-1)；n<2 未定义。 */
export function sampleVariance(s: Summary): number | null {
  if (s.n < 2) return null;
  return s.m2 / (s.n - 1);
}

/** 校验导入的摘要是否合法（仅凭三统计量无法验证其来源数据）。 */
export function validateImported(raw: unknown): Summary {
  if (typeof raw !== "object" || raw === null) throw err.invalidInput("摘要必须是对象");
  const o = raw as Record<string, unknown>;
  const version = o.version;
  if (version !== RULES_VERSION)
    throw err.versionMismatch(`不支持的规则版本: ${String(version)}（当前 ${RULES_VERSION}）`);
  const n = o.n;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0)
    throw err.invalidInput("n 必须是非负整数");
  if (n > MAX_N) throw err.countOutOfRange(`n 超过上限 ${MAX_N}`);
  const mean = o.mean;
  const m2 = o.m2;
  if (typeof mean !== "number" || !Number.isFinite(mean))
    throw err.nonFinite("mean 必须是有限数");
  if (typeof m2 !== "number" || !Number.isFinite(m2))
    throw err.nonFinite("m2 必须是有限数");
  if (n === 0 && (mean !== 0 || m2 !== 0))
    throw err.invalidInput("零样本摘要的规范表示为 n=0, mean=0, m2=0");
  if (n > 0 && Math.abs(mean) > MAX_ABS_VALUE)
    throw err.valueOutOfRange(`mean 超出样本值允许范围 ${MAX_ABS_VALUE}`);
  const fixed = sanitizeM2(m2, n, mean);
  return { n, mean, m2: fixed, version: RULES_VERSION };
}
