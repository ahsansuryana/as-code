import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { getAuditStore } from './audit.js';
import { getOAuthStore } from './oauth/store.js';
import { createOAuthRouter, resolveBaseUrl } from './oauth/routes.js';
import { createOpenApiRouter } from './openapi.js';
import { checkKernelConfinement } from './security.js';

import { registerFilesystemReadTools } from './tools/filesystem-read.js';
import { registerFilesystemWriteTools } from './tools/filesystem-write.js';
import { registerExecutionSessionTools } from './tools/execution-session.js';
import { registerTaskTools } from './tools/tasks.js';
import { registerInteractionTools } from './tools/interaction.js';
import { registerServerInfoTools } from './tools/server-info.js';
import { registerPermissionTools } from './tools/permissions.js';

// Check kernel confinement status on startup
checkKernelConfinement();

if (config.MCP_SKIP_PERMISSIONS) {
  console.warn('⚠️ WARNING: MCP_SKIP_PERMISSIONS=true is set. Destructive tools will execute without explicit approval!');
}

if (config.MCP_TOOL_PROFILE === 'compat-readonly-all') {
  console.warn('⚠️ WARNING: MCP_TOOL_PROFILE=compat-readonly-all IS NOT A SECURE MODE. Destructive tools remain exposed!');
}

// ─── MCP Server ──────────────────────────────────────────────────────────────
const mcpServer = new McpServer({
  name: 'remote-ai-coding-agent',
  version: '0.1.0',
});

registerFilesystemReadTools(mcpServer);
registerFilesystemWriteTools(mcpServer);
registerExecutionSessionTools(mcpServer);
registerTaskTools(mcpServer);
registerInteractionTools(mcpServer);
registerServerInfoTools(mcpServer);
registerPermissionTools(mcpServer);

// ─── Express App ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Global CORS & Preflight middleware ──────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, mcp-session-id');
  res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  next();
});

// ─── OAuth 2.1 & ChatGPT OpenAPI routes (public) ─────────────────────────────
app.use(createOAuthRouter());
app.use(createOpenApiRouter());

// ─── Auth middleware: validate OAuth Bearer token ─────────────────────────────
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const publicPaths = ['/health', '/oauth/', '/.well-known/', '/openapi.json'];
  if (publicPaths.some(p => req.path.startsWith(p))) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    const baseUrl = resolveBaseUrl(req);
    res.setHeader(
      'WWW-Authenticate',
      `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`
    );
    res.status(401).json({
      error: 'unauthorized',
      message: 'Bearer token required. Connect via OAuth or set Authorization header.',
    });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();

  const oauthValid = getOAuthStore().validateToken(token);
  const staticValid = token === config.BEARER_TOKEN;

  if (!oauthValid && !staticValid) {
    const baseUrl = resolveBaseUrl(req);
    res.setHeader(
      'WWW-Authenticate',
      `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", error="invalid_token"`
    );
    res.status(401).json({ error: 'invalid_token', message: 'Token is invalid or expired' });
    return;
  }

  next();
}

app.use(requireAuth);

// ─── Health check (public) ───────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const baseUrl = resolveBaseUrl(req);
  res.json({
    status: 'ok',
    server: 'remote-ai-coding-agent',
    version: '0.1.0',
    permission_mode: config.PERMISSION_MODE,
    tool_profile: config.MCP_TOOL_PROFILE,
    skip_permissions: config.MCP_SKIP_PERMISSIONS,
    project_root: config.PROJECT_ROOT,
    base_url: baseUrl,
    timestamp: new Date().toISOString(),
  });
});

// ─── Audit log endpoint ──────────────────────────────────────────────────────
app.get('/audit', (req, res) => {
  const limit = parseInt(String(req.query['limit'] ?? '50'), 10);
  const entries = getAuditStore().recent(Math.min(limit, 200));
  res.json({ entries, count: entries.length });
});

// ─── MCP endpoint (Streamable HTTP, stateless for Claude / MCP clients) ─────
app.post('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  res.on('close', () => { transport.close(); });

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// ─── Start ───────────────────────────────────────────────────────────────────
const { PORT, BIND_ADDRESS } = config;
app.listen(PORT, BIND_ADDRESS, () => {
  const pad = (s: string, w = 48) => s.padEnd(w);
  const b = '\u2551';
  const line = '\u2550'.repeat(52);
  console.log([
    '\u2554' + line + '\u2557',
    `${b} ${pad('remote-ai MCP & ChatGPT REST Server v0.1.0')} ${b}`,
    '\u2560' + line + '\u2563',
    `${b} ${pad(`Listening:  http://${BIND_ADDRESS}:${PORT}`)} ${b}`,
    `${b} ${pad('MCP:        POST /mcp')} ${b}`,
    `${b} ${pad('OpenAPI:    GET  /openapi.json (ChatGPT)')} ${b}`,
    `${b} ${pad('OAuth:      GET  /oauth/authorize')} ${b}`,
    `${b} ${pad('Token:      POST /oauth/token')} ${b}`,
    `${b} ${pad('Discovery:  GET  /.well-known/oauth-authorization-server')} ${b}`,
    `${b} ${pad('Health:     GET  /health')} ${b}`,
    `${b} ${pad('Audit:      GET  /audit')} ${b}`,
    '\u2560' + line + '\u2563',
    `${b} ${pad(`Profile: ${config.MCP_TOOL_PROFILE}`)} ${b}`,
    `${b} ${pad(`SkipPerms: ${config.MCP_SKIP_PERMISSIONS}`)} ${b}`,
    `${b} ${pad(`Root: ${config.PROJECT_ROOT.slice(0, 42)}`)} ${b}`,
    '\u255a' + line + '\u255d',
  ].join('\n'));
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────
process.on('SIGTERM', () => { getAuditStore().close(); process.exit(0); });
process.on('SIGINT',  () => { getAuditStore().close(); process.exit(0); });
