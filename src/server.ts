import * as http from "node:http";
import { AddressInfo } from "node:net";
import { Store } from "./store";
import {
  updateBatch, merge, populationVariance, sampleVariance, RULES_VERSION,
  MAX_ABS_VALUE, MAX_BATCH, MAX_N, M2_NEG_REL_TOL, Summary,
} from "./welford";
import { ApiError, err } from "./errors";

function view(s: Summary) {
  return {
    n: s.n,
    mean: s.n === 0 ? null : s.mean,
    m2: s.m2,
    version: s.version,
    populationVariance: populationVariance(s),
    sampleVariance: sampleVariance(s),
    varianceDenominator: { population: "n", sample: "n-1" },
  };
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024 * 1024) throw err.batchTooLarge("请求体超过 64MB");
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw err.invalidInput("请求体不是合法 JSON");
  }
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      const data = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(data);
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const body = method === "POST" ? ((await readBody(req)) as Record<string, unknown>) : {};

      if (method === "GET" && url.pathname === "/version") {
        return send(200, {
          rulesVersion: RULES_VERSION,
          limits: { MAX_ABS_VALUE, MAX_BATCH, MAX_N, M2_NEG_REL_TOL },
          precision: "双精度浮点 (IEEE 754 binary64)；不承诺任意排列/分批逐位一致",
        });
      }
      if (method === "GET" && url.pathname === "/summaries") {
        return send(200, store.list().map((s) => ({ id: s.id, ...view(s) })));
      }
      if (method === "POST" && url.pathname === "/summaries") {
        const id = (body.id as string) ?? `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const s = store.create(id, body.requestId as string | undefined);
        return send(201, { id, ...view(s) });
      }
      if (method === "POST" && url.pathname === "/merge") {
        const a = store.get(String(body.a));
        const b = store.get(String(body.b));
        const merged = merge(a, b); // 不修改来源
        const id = (body.id as string) ?? `m-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const saved = store.create(id, body.requestId as string | undefined);
        // create 生成空摘要，这里用事务覆盖为合并结果
        store.applyUpdate(id, merged, "merge", undefined, { a: body.a, b: body.b }, merged);
        void saved;
        return send(201, { id, ...view(merged) });
      }
      if (method === "POST" && url.pathname === "/import") {
        const id = String(body.id ?? "");
        if (!id) throw err.invalidInput("import 需要 id");
        const s = store.importSummary(id, body.summary, body.requestId as string | undefined);
        return send(201, { id, ...view(s) });
      }
      if (method === "GET" && url.pathname === "/compare") {
        const a = store.get(String(url.searchParams.get("a")));
        const b = store.get(String(url.searchParams.get("b")));
        return send(200, {
          a: a.version,
          b: b.version,
          sameRulesVersion: a.version === b.version,
          mergeable: a.version === b.version,
        });
      }

      if (parts[0] === "summaries" && parts.length >= 2) {
        const id = decodeURIComponent(parts[1]);
        if (method === "GET" && parts.length === 2) {
          return send(200, { id, ...view(store.get(id)) });
        }
        if (method === "GET" && parts[2] === "export") {
          return send(200, { id, summary: store.get(id) });
        }
        if (method === "GET" && parts[2] === "ops") {
          store.get(id);
          return send(200, { id, ops: store.ops(id) });
        }
        if (method === "POST" && parts[2] === "values") {
          const requestId = body.requestId as string | undefined;
          if (requestId) {
            const prev = store.findOpByRequestId(id, requestId);
            if (prev) return send(200, { id, ...JSON.parse(prev.result), idempotentReplay: true });
          }
          const cur = store.get(id);
          const { summary, explanations } = updateBatch(cur, body.values as unknown[]);
          const result = {
            ...view(summary),
            updated: explanations.length,
            lastUpdate: explanations[explanations.length - 1],
          };
          store.applyUpdate(id, summary, "append", requestId, { values: body.values }, result);
          return send(200, { id, ...result });
        }
        if (method === "GET" && parts[2] === "explanation") {
          const ops = store.ops(id, 1);
          if (ops.length === 0) return send(200, { id, explanation: null });
          const result = JSON.parse(ops[0].result) as { lastUpdate?: unknown };
          return send(200, { id, op: ops[0].op, explanation: result.lastUpdate ?? null });
        }
      }
      throw err.notFound(`未知路由: ${method} ${url.pathname}`);
    } catch (e) {
      if (e instanceof ApiError) {
        send(e.httpStatus, { error: { code: e.code, message: e.message } });
      } else {
        send(500, { error: { code: "INTERNAL", message: String(e) } });
      }
    }
  });
}

if (require.main === module) {
  const store = new Store();
  const server = createServer(store);
  const portArg = process.env.PORT ? Number(process.env.PORT) : 0; // 默认选择空闲端口
  server.listen(portArg, "127.0.0.1", () => {
    const addr = server.address() as AddressInfo;
    console.log(`Welford 服务已启动: http://127.0.0.1:${addr.port} (规则版本 ${RULES_VERSION})`);
  });
}
