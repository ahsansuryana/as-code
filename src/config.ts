import { z } from 'zod';
import path from 'path';
import fs from 'fs';

const ConfigSchema = z.object({
  PORT: z.coerce.number().default(3000),
  BEARER_TOKEN: z.string().min(16, 'BEARER_TOKEN must be at least 16 characters'),
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

export const config = {
  ...parsed.data,
  commandAllowlist: parsed.data.COMMAND_ALLOWLIST.split(',').map(s => s.trim()).filter(Boolean),
  webFetchAllowlist: parsed.data.WEB_FETCH_ALLOWLIST.split(',').map(s => s.trim()).filter(Boolean),
} as const;

export type Config = typeof config;
