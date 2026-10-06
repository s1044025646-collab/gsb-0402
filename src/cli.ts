/** CLI：create / add / variance / explain / merge / list / export / import / ops / serve */
import { Service } from "./service";
import { Store, defaultDbPath } from "./store";
import { startServer } from "./server";
import * as fs from "node:fs";

function parseArgs(argv: string[]): { cmd: string; positional: string[]; opts: Record<string, string> } {
  const positional: string[] = [];
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) { opts[key] = next; i++; }
      else opts[key] = "true";
    } else positional.push(argv[i]);
  }
  const cmd = positional.shift() ?? "help";
  return { cmd, positional, opts };
}

function out(x: unknown): void {
  console.log(JSON.stringify(x, null, 2));
}

function main(): void {
  const { cmd, positional, opts } = parseArgs(process.argv.slice(2));
  const dbPath = opts.db ?? process.env.DB_PATH ?? defaultDbPath();

  if (cmd === "serve") {
    const port = Number(opts.port ?? process.env.PORT ?? 0);
    startServer(dbPath, port).then(({ port }) => {
      console.log(`Welford API 已启动: http://localhost:${port}  (数据库: ${dbPath})`);
    });
    return;
  }

  const svc = new Service(new Store(dbPath));
  try {
    switch (cmd) {
      case "create": {
        out(svc.create(positional[0]));
        break;
      }
      case "add": {
        const id = positional[0];
        const values = positional.slice(1).map(Number);
        if (values.length === 0 || values.some((v) => Number.isNaN(v))) {
          console.error("错误: 需要至少一个可解析为数字的值");
          process.exitCode = 2;
          return;
        }
        out(svc.append(id, values, opts["request-id"]));
        break;
      }
      case "variance": {
        out(svc.variance(positional[0]));
        break;
      }
      case "explain": {
        out(svc.explain(positional[0], Number(positional[1])));
        break;
      }
      case "merge": {
        out(svc.merge(positional[0], positional[1], positional[2]));
        break;
      }
      case "list": {
        out(svc.list());
        break;
      }
      case "export": {
        out(svc.export(positional[0]));
        break;
      }
      case "import": {
        const data = JSON.parse(fs.readFileSync(positional[0], "utf8"));
        out(svc.import(data, positional[1]));
        break;
      }
      case "ops": {
        out(svc.operations(positional[0]));
        break;
      }
      default:
        console.log(`用法: node dist/cli.js [--db 路径] <命令> [参数]
  create [id]                 创建空摘要
  add <id> <v...>             追加一个或多个值（可带 --request-id 幂等）
  variance <id>               查询总体/样本方差
  explain <id> <v>            解释追加 v 前后的 n/mean/M2 与贡献
  merge <idA> <idB> [newId]   合并两个摘要为新快照（不修改来源）
  list                        列出全部摘要
  export <id>                 导出摘要 JSON
  import <file> [newId]       从 JSON 文件导入摘要
  ops <id>                    查看操作记录
  serve [--port N]            启动 HTTP API（默认自动选择空闲端口）`);
    }
  } catch (e: any) {
    console.error(`错误 [${e.code ?? "INTERNAL"}]: ${e.message}`);
    process.exitCode = 1;
  } finally {
    svc.store.close();
  }
}

main();
