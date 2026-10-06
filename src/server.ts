/** HTTP API 服务器（node:http，无外部依赖）。默认端口 0 = 自动选择空闲端口。 */
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { Service } from "./service";
import { Store, defaultDbPath } from "./store";
import { WelfordError, RULES_VERSION } from "./welford";

const ERROR_STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  RULES_VERSION_MISMATCH: 409,
  NON_FINITE_VALUE: 422,
  VALUE_OUT_OF_RANGE: 422,
  INVALID_SUMMARY: 422,
  INVALID_IMPORT: 422,
  EMPTY_BATCH: 400,
  BATCH_TOO_LARGE: 400,
  COUNT_LIMIT: 400,
  BAD_REQUEST: 400,
};

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) reject(new WelfordError("BAD_REQUEST", "请求体过大"));
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new WelfordError("BAD_REQUEST", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createServer(service: Service): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";
      const body = method === "POST" || method === "PUT" ? await readBody(req) : {};
      const requestId = req.headers["x-request-id"] as string | undefined;

      if (method === "GET" && url.pathname === "/health") {
        return send(res, 200, { ok: true, rulesVersion: RULES_VERSION });
      }
      if (method === "POST" && parts[0] === "summaries" && parts.length === 1) {
        return send(res, 201, service.create(body.id, body.initial));
      }
      if (method === "GET" && parts[0] === "summaries" && parts.length === 1) {
        return send(res, 200, service.list());
      }
      if (parts[0] === "summaries" && parts.length >= 2) {
        const id = decodeURIComponent(parts[1]);
        const action = parts[2];
        if (method === "GET" && !action) return send(res, 200, service.get(id));
        if (method === "GET" && action === "variance") return send(res, 200, service.variance(id));
        if (method === "GET" && action === "operations") return send(res, 200, service.operations(id));
        if (method === "GET" && action === "export") return send(res, 200, service.export(id));
        if (method === "POST" && action === "append") {
          const values = body.values ?? (body.value !== undefined ? [body.value] : undefined);
          if (!Array.isArray(values)) {
            throw new WelfordError("BAD_REQUEST", "需要 values 数组或 value 单值");
          }
          return send(res, 200, service.append(id, values, requestId ?? body.requestId));
        }
        if (method === "POST" && action === "explain") {
          return send(res, 200, service.explain(id, body.value));
        }
        if (method === "POST" && action === "merge") {
          if (!body.otherId) throw new WelfordError("BAD_REQUEST", "需要 otherId");
          return send(res, 201, service.merge(id, body.otherId, body.newId));
        }
      }
      if (method === "POST" && parts[0] === "import") {
        return send(res, 201, service.import(body.data ?? body, body.newId));
      }
      send(res, 404, { error: { code: "NOT_FOUND", message: "路由不存在" } });
    } catch (e: any) {
      if (e instanceof WelfordError) {
        send(res, ERROR_STATUS[e.code] ?? 400, { error: { code: e.code, message: e.message } });
      } else {
        send(res, 500, { error: { code: "INTERNAL", message: String(e?.message ?? e) } });
      }
    }
  });
}

export function startServer(dbPath: string, port: number): Promise<{ server: http.Server; port: number }> {
  const service = new Service(new Store(dbPath));
  const server = createServer(service);
  return new Promise((resolve) => {
    server.listen(port, () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, port: addr.port });
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 0);
  const dbPath = process.env.DB_PATH ?? defaultDbPath();
  startServer(dbPath, port).then(({ port }) => {
    console.log(`Welford API 已启动: http://localhost:${port}  (数据库: ${dbPath})`);
  });
}
