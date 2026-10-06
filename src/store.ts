import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { Summary, UpdateExplanation, RULES_VERSION, validateImported } from "./welford";
import { err } from "./errors";

export const DATA_DIR = path.join(process.cwd(), "data");
export const DB_PATH = process.env.WELFORD_DB || path.join(DATA_DIR, "welford.db");

export interface OpRecord {
  id: number;
  summaryId: string;
  op: string;
  requestId: string | null;
  payload: string;
  result: string;
  createdAt: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string = DB_PATH) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS summaries (
        id TEXT PRIMARY KEY,
        n INTEGER NOT NULL,
        mean REAL NOT NULL,
        m2 REAL NOT NULL,
        version TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS ops (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        summary_id TEXT NOT NULL,
        op TEXT NOT NULL,
        request_id TEXT,
        payload TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (summary_id, request_id)
      );
    `);
  }

  private rowToSummary(row: unknown): Summary {
    const r = row as { n: number; mean: number; m2: number; version: string };
    return { n: r.n, mean: r.mean, m2: r.m2, version: r.version };
  }

  get(id: string): Summary {
    const row = this.db.prepare("SELECT n, mean, m2, version FROM summaries WHERE id = ?").get(id);
    if (!row) throw err.notFound(`摘要不存在: ${id}`);
    return this.rowToSummary(row);
  }

  exists(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM summaries WHERE id = ?").get(id);
  }

  list(): Array<Summary & { id: string }> {
    const rows = this.db.prepare("SELECT id, n, mean, m2, version FROM summaries ORDER BY created_at").all();
    return rows.map((r) => ({ id: (r as { id: string }).id, ...this.rowToSummary(r) }));
  }

  /** 幂等检查：同一 (summaryId, requestId) 已成功则直接返回原结果。 */
  findOpByRequestId(summaryId: string, requestId: string): OpRecord | null {
    const row = this.db
      .prepare("SELECT * FROM ops WHERE summary_id = ? AND request_id = ?")
      .get(summaryId, requestId);
    return (row as unknown as OpRecord) ?? null;
  }

  private recordOp(summaryId: string, op: string, requestId: string | null, payload: unknown, result: unknown): void {
    this.db
      .prepare("INSERT INTO ops (summary_id, op, request_id, payload, result) VALUES (?, ?, ?, ?, ?)")
      .run(summaryId, op, requestId, JSON.stringify(payload), JSON.stringify(result));
  }

  private writeSummary(id: string, s: Summary): void {
    this.db
      .prepare(
        `INSERT INTO summaries (id, n, mean, m2, version, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET n=excluded.n, mean=excluded.mean, m2=excluded.m2,
           version=excluded.version, updated_at=datetime('now')`
      )
      .run(id, s.n, s.mean, s.m2, s.version);
  }

  create(id: string, requestId?: string): Summary {
    if (!id || typeof id !== "string" || id.length > 128)
      throw err.invalidInput("id 必须是 1-128 字符的字符串");
    if (requestId) {
      const prev = this.findOpByRequestId(id, requestId);
      if (prev) return JSON.parse(prev.result) as Summary;
    }
    if (this.exists(id)) throw err.conflict(`摘要已存在: ${id}`);
    const s: Summary = { n: 0, mean: 0, m2: 0, version: RULES_VERSION };
    this.db.exec("BEGIN");
    try {
      this.writeSummary(id, s);
      this.recordOp(id, "create", requestId ?? null, {}, s);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return s;
  }

  /** 原子地应用一次更新：摘要写入与操作记录在同一事务中。 */
  applyUpdate(
    id: string,
    next: Summary,
    op: string,
    requestId: string | undefined,
    payload: unknown,
    result: unknown
  ): void {
    this.db.exec("BEGIN");
    try {
      this.writeSummary(id, next);
      this.recordOp(id, op, requestId ?? null, payload, result);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  importSummary(id: string, raw: unknown, requestId?: string): Summary {
    if (requestId) {
      const prev = this.findOpByRequestId(id, requestId);
      if (prev) return JSON.parse(prev.result) as Summary;
    }
    if (this.exists(id)) throw err.conflict(`摘要已存在: ${id}`);
    const s = validateImported(raw);
    this.db.exec("BEGIN");
    try {
      this.writeSummary(id, s);
      this.recordOp(id, "import", requestId ?? null, raw, s);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return s;
  }

  ops(id: string, limit = 50): OpRecord[] {
    return this.db
      .prepare("SELECT * FROM ops WHERE summary_id = ? ORDER BY id DESC LIMIT ?")
      .all(id, limit) as unknown as OpRecord[];
  }

  close(): void {
    this.db.close();
  }
}

export function withExplanations(e: UpdateExplanation[]): UpdateExplanation[] {
  return e;
}
