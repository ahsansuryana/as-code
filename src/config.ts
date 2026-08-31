import { z } from 'zod';
import path from 'path';
import fs from 'fs';

const ConfigSchema = z.object({
  PORT: z.coerce.number().default(3000),
  // Preferred: a salted scrypt hash produced by `npm run generate-token`.
  // The raw secret is never written to disk — only its hash lives in .env.
  BEARER_TOKEN_HASH: z.string().optional(),
  // Deprecated: raw plaintext secret. Still supported so existing deployments
  // keep working, but anyone who reads .env gets a working credential
  // immediately. Migrate with `npm run generate-token`.
  BEARER_TOKEN: z.string().min(16, 'BEARER_TOKEN must be at least 16 characters').optional(),
  // Optional Git credentials for HTTPS Git operations. These are injected only
  // into Git child processes via GIT_ASKPASS; they are not exposed to the MCP
  // server's normal command environment.
  GIT_USER: z.string().min(1).optional(),
  GIT_PAT: z.string().min(1).optional(),
  // Optional Git commit identity. Applied only to Git processes, so the
  // container's global Git configuration does not need to be modified.
  GIT_COMMIT_NAME: z.string().min(1).optional(),
  GIT_COMMIT_EMAIL: z.string().email().optional(),
  PROJECT_ROOT: z.string().min(1),
  PERMISSION_MODE: z.enum(['manual', 'scoped-auto', 'bypass']).default('manual'),
  COMMAND_ALLOWLIST: z.string().default('npm,git,node,npx,python,python3'),
  COMMAND_TIMEOUT_CEILING_MS: z.coerce.number().default(600000),
  AUDIT_DB_PATH: z.string().default('./data/audit.db'),
  WEB_FETCH_ALLOWLIST: z.string().default(''),
  BIND_ADDRESS: z.string().default('127.0.0.1'),

  // New configuration options
  MCP_TOOL_PROFILE: z.enum(['full', 'read-only', 'compat-readonly-all']).default('full'),
  MCP_SKIP_PERMISSIONS: z.coerce.boolean().default(false),
  SESSION_WATCHDOG_TIMEOUT_MS: z.coerce.number().default(1800000), // 30 mins
});

function loadEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^"|"$/g, '');
      if (!(key in process.env)) process.env[key] = val;
    }
  }
}

loadEnv();

const parsed = ConfigSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid configuration:');
  console.error(parsed.error.format());
  process.exit(1);
}

if (Boolean(parsed.data.GIT_USER) !== Boolean(parsed.data.GIT_PAT)) {
  console.error('❌ Invalid configuration: GIT_USER and GIT_PAT must be provided together.');
  process.exit(1);
}

if (Boolean(parsed.data.GIT_COMMIT_NAME) !== Boolean(parsed.data.GIT_COMMIT_EMAIL)) {
  console.error('❌ Invalid configuration: GIT_COMMIT_NAME and GIT_COMMIT_EMAIL must be provided together.');
  process.exit(1);
}

if (!parsed.data.BEARER_TOKEN_HASH && !parsed.data.BEARER_TOKEN) {
  console.error('❌ Invalid configuration: set BEARER_TOKEN_HASH (recommended) or legacy BEARER_TOKEN in .env');
  console.error('   Run `npm run generate-token` to create one.');
  process.exit(1);
}

const usingLegacyPlaintextToken = !parsed.data.BEARER_TOKEN_HASH;
if (usingLegacyPlaintextToken) {
  console.warn(
    '⚠️  Using legacy plaintext BEARER_TOKEN from .env. If this file leaks, that secret is usable immediately. ' +
    'Run `npm run generate-token` to switch to a hashed BEARER_TOKEN_HASH, then remove BEARER_TOKEN from .env.'
  );
}

export const config = {
  ...parsed.data,
  // Unified secret used for verification (see token-auth.ts). Prefers the
  // hash; falls back to the legacy plaintext value during migration.
  AUTH_SECRET: (parsed.data.BEARER_TOKEN_HASH ?? parsed.data.BEARER_TOKEN) as string,
  USING_LEGACY_PLAINTEXT_TOKEN: usingLegacyPlaintextToken,
  commandAllowlist: parsed.data.COMMAND_ALLOWLIST.split(',').map(s => s.trim()).filter(Boolean),
  webFetchAllowlist: parsed.data.WEB_FETCH_ALLOWLIST.split(',').map(s => s.trim()).filter(Boolean),
} as const;

export type Config = typeof config;
