/**
 * SQLite 持久化层（node:sqlite，无需外部依赖）。
 * 每个摘要一行（n, mean, m2, rules_version），操作记录单独一张表。
 * 所有写操作在事务内完成：批次含非法值时整体拒绝，不落前半批。
 */
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  Summary, RULES_VERSION, validateSummary, WelfordError,
} from "./welford";

export interface StoredSummary extends Summary {
  id: string;
  rulesVersion: number;
  createdAt: string;
  updatedAt: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS summaries (
        id TEXT PRIMARY KEY,
        n INTEGER NOT NULL,
        mean REAL NOT NULL,
        m2 REAL NOT NULL,
        rules_version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        summary_id TEXT NOT NULL,
        op TEXT NOT NULL,
        payload TEXT NOT NULL,
        request_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_request
        ON operations(summary_id, request_id) WHERE request_id IS NOT NULL;
    `);
  }

  close(): void {
    this.db.close();
  }

  create(id: string, initial?: Summary): StoredSummary {
    const s = initial ?? { n: 0, mean: 0, m2: 0 };
    validateSummary(s);
    const now = new Date().toISOString();
    try {
      this.db.prepare(
        "INSERT INTO summaries(id,n,mean,m2,rules_version,created_at,updated_at) VALUES(?,?,?,?,?,?,?)"
      ).run(id, s.n, s.mean, s.m2, RULES_VERSION, now, now);
    } catch (e: any) {
      if (String(e.message).includes("UNIQUE")) {
        throw new WelfordError("ALREADY_EXISTS", `摘要 '${id}' 已存在`);
      }
      throw e;
    }
    this.logOp(id, "create", s, null);
    return this.get(id)!;
  }

  get(id: string): StoredSummary | null {
    const row = this.db.prepare("SELECT * FROM summaries WHERE id = ?").get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      n: row.n,
      mean: row.mean,
      m2: row.m2,
      rulesVersion: row.rules_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  require(id: string): StoredSummary {
    const s = this.get(id);
    if (!s) throw new WelfordError("NOT_FOUND", `摘要 '${id}' 不存在`);
    if (s.rulesVersion !== RULES_VERSION) {
      throw new WelfordError(
        "RULES_VERSION_MISMATCH",
        `摘要规则版本 ${s.rulesVersion} 与当前 ${RULES_VERSION} 不一致`
      );
    }
    return s;
  }

  list(): StoredSummary[] {
    const rows = this.db.prepare("SELECT id FROM summaries ORDER BY created_at").all() as any[];
    return rows.map((r) => this.get(r.id)!);
  }

  /**
   * 原子替换摘要状态并记录操作。
   * requestId 非空时用于请求幂等：同一 (summaryId, requestId) 重复提交直接返回已有状态。
   */
  applyUpdate(id: string, next: Summary, op: string, payload: unknown, requestId: string | null): StoredSummary {
    if (requestId) {
      const dup = this.db.prepare(
        "SELECT 1 FROM operations WHERE summary_id = ? AND request_id = ?"
      ).get(id, requestId);
      if (dup) {
        return this.require(id); // 幂等重试：返回当前状态，不重复应用
      }
    }
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE summaries SET n=?, mean=?, m2=?, updated_at=? WHERE id=?")
        .run(next.n, next.mean, next.m2, now, id);
      this.logOp(id, op, payload, requestId);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return this.require(id);
  }

  private logOp(id: string, op: string, payload: unknown, requestId: string | null): void {
    this.db.prepare(
      "INSERT INTO operations(summary_id,op,payload,request_id,created_at) VALUES(?,?,?,?,?)"
    ).run(id, op, JSON.stringify(payload), requestId, new Date().toISOString());
  }

  operations(id: string): any[] {
    return this.db.prepare(
      "SELECT seq, op, payload, request_id, created_at FROM operations WHERE summary_id = ? ORDER BY seq"
    ).all(id) as any[];
  }
}

export function defaultDbPath(): string {
  return path.join(process.cwd(), "data", "welford.db");
}
