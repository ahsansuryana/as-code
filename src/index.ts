import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { config } from './config.js';
import { getAuditStore } from './audit.js';
import { getOAuthStore } from './oauth/store.js';
import { createOAuthRouter, resolveBaseUrl } from './oauth/routes.js';
import { createOpenApiRouter } from './openapi.js';
import { checkKernelConfinement } from './security.js';
import { verifyTokenHash } from './token-auth.js';

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

// ─── MCP Server Factory ────────────────────────────────────────────────────
// A fresh McpServer + tool registration per connection. This is important for
// long-lived transports (SSE): the underlying Protocol class binds responses
// to whichever transport last called connect(), so sharing one McpServer
// instance across concurrent sessions (e.g. a Claude /mcp request landing
// while a ChatGPT /sse session is open) would cross-wire replies. Building a
// fresh instance per connection keeps every session fully isolated.
function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'remote-ai-coding-agent',
    version: '0.1.0',
  });

  registerFilesystemReadTools(server);
  registerFilesystemWriteTools(server);
  registerExecutionSessionTools(server);
  registerTaskTools(server);
  registerInteractionTools(server);
  registerServerInfoTools(server);
  registerPermissionTools(server);

  return server;
}

// Active SSE sessions, keyed by transport sessionId, for routing POST /messages.
const sseTransports = new Map<string, SSEServerTransport>();

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

// ─── Auth middleware: validate OAuth Bearer token ─────────────────────────────
// Mounted BEFORE the OAuth and OpenAPI routers (not after) so nothing added to
// either router is accidentally left unauthenticated. The OAuth discovery /
// authorize / token endpoints and the OpenAPI spec document must stay public
// to work at all — they're allow-listed by path below — but anything else
// those routers expose (notably POST /api/v1/tools/:toolName, which actually
// executes tools for ChatGPT Actions) now requires a valid token by default.
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
  const staticValid = verifyTokenHash(token, config.AUTH_SECRET);

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

// ─── OAuth 2.1 & ChatGPT OpenAPI routes ──────────────────────────────────────
// (Individually public paths are allow-listed inside requireAuth above;
// POST /api/v1/tools/:toolName inside createOpenApiRouter is NOT allow-listed
// and therefore requires auth like every other tool-execution endpoint.)
app.use(createOAuthRouter());
app.use(createOpenApiRouter());

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

  await createMcpServer().connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// ─── SSE endpoint (legacy transport, for ChatGPT custom connectors) ─────────
// GET /sse opens a long-lived event stream; the SDK sends back an `endpoint`
// event pointing the client at POST /messages?sessionId=<id> for outbound
// JSON-RPC calls. Each session gets its own McpServer instance (see
// createMcpServer) so concurrent SSE + /mcp clients never interfere.
app.get('/sse', async (req, res) => {
  const transport = new SSEServerTransport('/messages', res);
  sseTransports.set(transport.sessionId, transport);

  res.on('close', () => {
    sseTransports.delete(transport.sessionId);
  });

  await createMcpServer().connect(transport);
});

app.post('/messages', async (req, res) => {
  const sessionId = String(req.query['sessionId'] ?? '');
  const transport = sseTransports.get(sessionId);

  if (!transport) {
    res.status(400).json({ error: 'invalid_session', message: 'Unknown or expired SSE sessionId' });
    return;
  }

  await transport.handlePostMessage(req, res, req.body);
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
    `${b} ${pad('MCP:        POST /mcp  (Claude / Streamable HTTP)')} ${b}`,
    `${b} ${pad('MCP:        GET  /sse  (ChatGPT / legacy SSE)')} ${b}`,
    `${b} ${pad('OpenAPI:    GET  /openapi.json (ChatGPT Actions)')} ${b}`,
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
