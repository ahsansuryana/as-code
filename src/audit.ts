import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from './config.js';

export interface AuditEntry {
  id?: number;
  timestamp: string;
  tool: string;
  input: string;
  result_preview: string;
  status: 'success' | 'error' | 'denied';
  duration_ms: number;
}

const SENSITIVE_KEY_REGEX = /^(token|password|secret|api_key|apikey|authorization|auth|bearer|access_token|refresh_token|private_key)$/i;

// Match common API keys, tokens, JWTs, and long hex/base64 strings without spaces (>20 chars)
const SENSITIVE_STRING_PATTERNS = [
  /ghp_[a-zA-Z0-9]{36}/g,
  /github_pat_[a-zA-Z0-9_]{20,}/g,
  /gho_[a-zA-Z0-9]{20,}/g,
  /ghu_[a-zA-Z0-9]{20,}/g,
  /ghs_[a-zA-Z0-9]{20,}/g,
  /ghr_[a-zA-Z0-9]{20,}/g,
  /sk-[a-zA-Z0-9]{32,}/g,
  /Bearer\s+[a-zA-Z0-9._~+/-]+=*/gi,
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
];

export function redactValue(val: unknown): unknown {
  if (val === null || val === undefined) return val;

  if (typeof val === 'string') {
    let redacted = val;
    for (const pattern of SENSITIVE_STRING_PATTERNS) {
      redacted = redacted.replace(pattern, '[REDACTED]');
    }
    return redacted;
  }

  if (Array.isArray(val)) {
    return val.map(item => redactValue(item));
  }

  if (typeof val === 'object') {
    const redactedObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (SENSITIVE_KEY_REGEX.test(k)) {
        redactedObj[k] = '[REDACTED]';
      } else {
        redactedObj[k] = redactValue(v);
      }
    }
    return redactedObj;
  }

  return val;
}

export function redactString(str: string): string {
  try {
    const parsed = JSON.parse(str);
    return JSON.stringify(redactValue(parsed));
  } catch {
    return String(redactValue(str));
  }
}

class AuditStore {
  private db: Database.Database;
  private insertStmt: Database.Statement;

  constructor() {
    const dbPath = path.resolve(process.cwd(), config.AUDIT_DB_PATH);
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp     TEXT    NOT NULL,
        tool          TEXT    NOT NULL,
        input         TEXT    NOT NULL,
        result_preview TEXT   NOT NULL,
        status        TEXT    NOT NULL CHECK(status IN ('success', 'error', 'denied')),
        duration_ms   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_tool      ON audit_log(tool);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
    `);

    this.insertStmt = this.db.prepare(`
      INSERT INTO audit_log (timestamp, tool, input, result_preview, status, duration_ms)
      VALUES (@timestamp, @tool, @input, @result_preview, @status, @duration_ms)
    `);
  }

  log(entry: Omit<AuditEntry, 'id'>): void {
    const redactedEntry = {
      ...entry,
      input: redactString(entry.input),
      result_preview: redactString(entry.result_preview),
    };
    this.insertStmt.run(redactedEntry);
  }

  recent(limit = 50): AuditEntry[] {
    return this.db.prepare(
      'SELECT * FROM audit_log ORDER BY id DESC LIMIT ?'
    ).all(limit) as AuditEntry[];
  }

  close(): void {
    this.db.close();
  }
}

let _store: AuditStore | null = null;
export function getAuditStore(): AuditStore {
  if (!_store) _store = new AuditStore();
  return _store;
}

export function withAudit<T>(
  tool: string,
  input: Record<string, unknown>,
  fn: () => Promise<T>
): Promise<T> {
  const store = getAuditStore();
  const start = Date.now();
  const redactedInput = JSON.stringify(redactValue(input));

  return fn()
    .then(result => {
      const redactedResultPreview = String(JSON.stringify(redactValue(result))).slice(0, 500);
      store.log({
        timestamp: new Date().toISOString(),
        tool,
        input: redactedInput,
        result_preview: redactedResultPreview,
        status: 'success',
        duration_ms: Date.now() - start,
      });
      return result;
    })
    .catch(err => {
      const errorMsg = String(err?.message ?? err);
      const redactedErrorPreview = String(redactValue(errorMsg)).slice(0, 500);
      store.log({
        timestamp: new Date().toISOString(),
        tool,
        input: redactedInput,
        result_preview: redactedErrorPreview,
        status: 'error',
        duration_ms: Date.now() - start,
      });
      throw err;
    });
}
