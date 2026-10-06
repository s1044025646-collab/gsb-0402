/** 业务服务层：组合核心算法与持久化，供 API 与 CLI 共用。 */
import { randomUUID } from "node:crypto";
import { Store, StoredSummary } from "./store";
import {
  Summary, WelfordError, RULES_VERSION,
  update, updateBatch, merge,
  populationVariance, sampleVariance, validateSummary,
  UpdateExplanation,
} from "./welford";

export interface VarianceView {
  n: number;
  mean: number | null;
  populationVariance: number | null; // M2/n，n=0 未定义
  sampleVariance: number | null;     // M2/(n-1)，n<2 未定义
  normalization: { population: "M2/n"; sample: "M2/(n-1)" };
}

export function varianceView(s: Summary): VarianceView {
  return {
    n: s.n,
    mean: s.n === 0 ? null : s.mean,
    populationVariance: populationVariance(s),
    sampleVariance: sampleVariance(s),
    normalization: { population: "M2/n", sample: "M2/(n-1)" },
  };
}

export class Service {
  constructor(public store: Store) {}

  create(id?: string, initial?: Summary): StoredSummary {
    const sid = id ?? randomUUID();
    if (initial) validateSummary(initial);
    return this.store.create(sid, initial);
  }

  get(id: string): StoredSummary {
    return this.store.require(id);
  }

  list(): StoredSummary[] {
    return this.store.list();
  }

  variance(id: string): VarianceView {
    return varianceView(this.store.require(id));
  }

  append(id: string, values: number[], requestId?: string): { summary: StoredSummary; explanations: UpdateExplanation[] } {
    const cur = this.store.require(id);
    // 内存中整体计算；任何非法值在此抛出，不落库 → 失败回滚
    const { summary, explanations } = updateBatch(cur, values);
    const saved = this.store.applyUpdate(
      id, summary, "append",
      { count: values.length, values: values.length <= 100 ? values : undefined },
      requestId ?? null
    );
    return { summary: saved, explanations };
  }

  explain(id: string, value: number): UpdateExplanation {
    const cur = this.store.require(id);
    return update(cur, value).explanation;
  }

  /** 合并两个已存摘要为新快照；不修改来源。拒绝规则版本不一致。 */
  merge(idA: string, idB: string, newId?: string): StoredSummary {
    const a = this.store.require(idA);
    const b = this.store.require(idB);
    if (a.rulesVersion !== b.rulesVersion) {
      throw new WelfordError(
        "RULES_VERSION_MISMATCH",
        `规则版本不一致：${idA}=v${a.rulesVersion}, ${idB}=v${b.rulesVersion}，禁止合并`
      );
    }
    const merged = merge(a, b);
    return this.create(newId, merged);
  }

  export(id: string): object {
    const s = this.store.require(id);
    return {
      format: "welford-summary",
      rulesVersion: s.rulesVersion,
      id: s.id,
      n: s.n,
      mean: s.mean,
      m2: s.m2,
    };
  }

  /** 导入：校验零样本表示、数量范围、有限数值、M2 合法性与规则版本。 */
  import(data: any, newId?: string): StoredSummary {
    if (!data || typeof data !== "object") {
      throw new WelfordError("INVALID_IMPORT", "导入内容必须是对象");
    }
    if (data.rulesVersion !== RULES_VERSION) {
      throw new WelfordError(
        "RULES_VERSION_MISMATCH",
        `导入规则版本 ${data.rulesVersion} 与当前 ${RULES_VERSION} 不一致`
      );
    }
    const s: Summary = { n: data.n, mean: data.mean, m2: data.m2 };
    validateSummary(s); // 含 n=0 时 mean/m2 必须为 0、M2 负值规则等
    return this.create(newId ?? data.id, s);
  }

  operations(id: string): any[] {
    this.store.require(id);
    return this.store.operations(id);
  }
}
