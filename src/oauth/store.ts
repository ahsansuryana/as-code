import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { config } from '../config.js';

export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  created_at: string;
}

export interface AuthCode {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  expires_at: number;
  used: boolean;
}

export interface AccessToken {
  token: string;
  client_id: string;
  issued_at: number;
  expires_at: number;
}

class OAuthStore {
  private db: Database.Database;

  constructor() {
    const dbPath = path.resolve(process.cwd(), config.AUDIT_DB_PATH);
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id     TEXT PRIMARY KEY,
        client_name   TEXT NOT NULL,
        redirect_uris TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS oauth_codes (
        code           TEXT PRIMARY KEY,
        client_id      TEXT NOT NULL,
        redirect_uri   TEXT NOT NULL,
        code_challenge TEXT NOT NULL,
        expires_at     INTEGER NOT NULL,
        used           INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        token       TEXT PRIMARY KEY,
        client_id   TEXT NOT NULL,
        issued_at   INTEGER NOT NULL,
        expires_at  INTEGER NOT NULL
      );
    `);
  }

  createClient(name: string, redirectUris: string[], customId?: string): OAuthClient {
    const client: OAuthClient = {
      client_id: customId || ('mcp_' + crypto.randomBytes(16).toString('hex')),
      client_name: name,
      redirect_uris: redirectUris,
      created_at: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT OR REPLACE INTO oauth_clients (client_id, client_name, redirect_uris, created_at)
      VALUES (?, ?, ?, ?)
    `).run(client.client_id, client.client_name, JSON.stringify(client.redirect_uris), client.created_at);
    return client;
  }

  getClient(clientId: string, fallbackRedirectUri?: string): OAuthClient {
    const row = this.db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').get(clientId) as any;
    if (row) {
      return { ...row, redirect_uris: JSON.parse(row.redirect_uris) };
    }
    // Auto-create client on demand if missing (helps with pre-configured Client IDs or DCR bypass)
    const uris = fallbackRedirectUri ? [fallbackRedirectUri] : ['https://claude.ai/oauth/callback', 'http://localhost'];
    return this.createClient('Claude Client', uris, clientId);
  }

  createAuthCode(clientId: string, redirectUri: string, codeChallenge: string): string {
    const code = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 10 * 60 * 1000;
    this.db.prepare(`
      INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, expires_at, used)
      VALUES (?, ?, ?, ?, ?, 0)
    `).run(code, clientId, redirectUri, codeChallenge, expiresAt);
    return code;
  }

  consumeAuthCode(code: string): AuthCode | null {
    const row = this.db.prepare('SELECT * FROM oauth_codes WHERE code = ?').get(code) as any;
    if (!row) return null;
    if (row.used) return null;
    if (Date.now() > row.expires_at) return null;
    this.db.prepare('UPDATE oauth_codes SET used = 1 WHERE code = ?').run(code);
    return { ...row, used: true };
  }

  createAccessToken(clientId: string, ttlMs = 365 * 24 * 60 * 60 * 1000): string {
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO oauth_tokens (token, client_id, issued_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).run(token, clientId, now, now + ttlMs);
    return token;
  }

  validateToken(token: string): AccessToken | null {
    const row = this.db.prepare('SELECT * FROM oauth_tokens WHERE token = ?').get(token) as any;
    if (!row) return null;
    if (Date.now() > row.expires_at) return null;
    return row as AccessToken;
  }

  close(): void {
    this.db.close();
  }
}

let _store: OAuthStore | null = null;
export function getOAuthStore(): OAuthStore {
  if (!_store) _store = new OAuthStore();
  return _store;
}
