import * as fs from "node:fs";
import { Store } from "./store";
import {
  updateBatch, merge, populationVariance, sampleVariance, RULES_VERSION,
  MAX_ABS_VALUE, MAX_BATCH, MAX_N, M2_NEG_REL_TOL, validateImported,
} from "./welford";

const store = new Store();

function view(id: string) {
  const s = store.get(id);
  return {
    id,
    n: s.n,
    mean: s.n === 0 ? null : s.mean,
    m2: s.m2,
    populationVariance: populationVariance(s),
    sampleVariance: sampleVariance(s),
    version: s.version,
  };
}

function print(x: unknown) {
  console.log(JSON.stringify(x, null, 2));
}

function fail(e: unknown): never {
  const anyE = e as { code?: string; message?: string };
  console.error(`错误 [${anyE.code ?? "INTERNAL"}]: ${anyE.message ?? String(e)}`);
  process.exit(1);
}

const [, , cmd, ...args] = process.argv;

try {
  switch (cmd) {
    case "create": {
      const id = args[0] ?? `s-${Date.now()}`;
      store.create(id);
      print(view(id));
      break;
    }
    case "add": {
      const [id, ...rest] = args;
      const values = rest.map(Number);
      const cur = store.get(id);
      const { summary, explanations } = updateBatch(cur, values);
      store.applyUpdate(id, summary, "append", undefined, { values }, { lastUpdate: explanations.at(-1) });
      print({ ...view(id), lastUpdate: explanations.at(-1) });
      break;
    }
    case "get":
      print(view(args[0]));
      break;
    case "list":
      print(store.list().map((s) => ({ id: s.id, n: s.n, mean: s.mean, m2: s.m2 })));
      break;
    case "explain": {
      const ops = store.ops(args[0], 1);
      print(ops.length ? JSON.parse(ops[0].result) : null);
      break;
    }
    case "merge": {
      const [aId, bId, newId] = args;
      const merged = merge(store.get(aId), store.get(bId));
      const id = newId ?? `m-${Date.now()}`;
      store.create(id);
      store.applyUpdate(id, merged, "merge", undefined, { a: aId, b: bId }, merged);
      print(view(id));
      break;
    }
    case "export": {
      print({ id: args[0], summary: store.get(args[0]) });
      break;
    }
    case "import": {
      const [id, file] = args;
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const s = validateImported(raw.summary ?? raw);
      store.importSummary(id, s);
      print(view(id));
      break;
    }
    case "compare": {
      const a = store.get(args[0]);
      const b = store.get(args[1]);
      print({ a: a.version, b: b.version, mergeable: a.version === b.version });
      break;
    }
    case "version":
      print({ rulesVersion: RULES_VERSION, limits: { MAX_ABS_VALUE, MAX_BATCH, MAX_N, M2_NEG_REL_TOL } });
      break;
    default:
      console.log(`用法: node dist/src/cli.js <命令> [参数]
  create <id>                 创建空摘要
  add <id> <v1> [v2 ...]      逐值/批量追加
  get <id>                    查询均值与两种方差
  explain <id>                查看最近一次更新解释
  merge <a> <b> [newId]       合并两个摘要为新快照（来源不变）
  export <id>                 导出摘要 JSON
  import <id> <file>          从 JSON 文件导入摘要
  compare <a> <b>             比较两者规则版本
  list                        列出全部摘要
  version                     查看规则版本与限制`);
  }
} catch (e) {
  fail(e);
} finally {
  store.close();
}
