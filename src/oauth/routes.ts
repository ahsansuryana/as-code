import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { getOAuthStore } from './store.js';
import { config } from '../config.js';
import { verifyTokenHash } from '../token-auth.js';

export function resolveBaseUrl(req: Request): string {
  // If explicitly configured to a real domain, use it
  if (process.env['PUBLIC_URL'] && !process.env['PUBLIC_URL'].includes('your-tunnel-url')) {
    return process.env['PUBLIC_URL'].replace(/\/$/, '');
  }
  // Otherwise resolve dynamically from request headers
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || req.headers['host'] || `localhost:${config.PORT}`;
  return `${proto}://${host}`.replace(/\/$/, '');
}

export function createOAuthRouter(): Router {
  const router = Router();

  // Middleware to attach CORS headers to all OAuth & well-known responses
  router.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, mcp-session-id');
    res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate');
    if (req.method === 'OPTIONS') {
      res.status(200).end();
      return;
    }
    next();
  });

  // ── Discovery: Protected Resource Metadata (RFC 9728) ────────────────────
  router.get('/.well-known/oauth-protected-resource', (req: Request, res: Response) => {
    const baseUrl = resolveBaseUrl(req);
    res.json({
      resource: `${baseUrl}/mcp`,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ['header'],
      resource_documentation: `${baseUrl}/health`,
    });
  });

  // ── Discovery: Authorization Server Metadata (RFC 8414) ─────────────────
  router.get('/.well-known/oauth-authorization-server', (req: Request, res: Response) => {
    const baseUrl = resolveBaseUrl(req);
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      registration_endpoint: `${baseUrl}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['mcp'],
      service_documentation: `${baseUrl}/health`,
    });
  });

  // ── Dynamic Client Registration (RFC 7591) ────────────────────────────────
  router.post('/oauth/register', (req: Request, res: Response) => {
    const body = req.body || {};
    const client_name = body.client_name || 'Claude Web Client';
    let redirect_uris = body.redirect_uris;

    if (typeof redirect_uris === 'string') {
      redirect_uris = [redirect_uris];
    } else if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      // Fallback default for Claude.ai
      redirect_uris = ['https://claude.ai/oauth/callback', 'https://claude.ai/api/auth/callback/mcp'];
    }

    const client = getOAuthStore().createClient(client_name, redirect_uris);

    res.status(201).json({
      client_id: client.client_id,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      client_id_issued_at: Math.floor(Date.now() / 1000),
    });
  });

  // ── Authorization Endpoint ────────────────────────────────────────────────
  router.get('/oauth/authorize', (req: Request, res: Response) => {
    const {
      response_type,
      client_id,
      redirect_uri,
      code_challenge,
      code_challenge_method,
      state,
    } = req.query as Record<string, string>;

    if (response_type !== 'code') {
      res.status(400).send('unsupported_response_type');
      return;
    }
    if (!client_id || !redirect_uri || !code_challenge) {
      res.status(400).send('invalid_request: missing client_id, redirect_uri, or code_challenge');
      return;
    }

    // Retrieve or auto-create client
    const client = getOAuthStore().getClient(client_id, redirect_uri);

    res.send(consentPage({
      clientName: client.client_name,
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      state: state ?? '',
    }));
  });

  // ── Consent Form Submission ───────────────────────────────────────────────
  router.post('/oauth/consent', (req: Request, res: Response) => {
    const { client_id, redirect_uri, code_challenge, state, password } = req.body as Record<string, string>;

    if (!verifyTokenHash(password, config.AUTH_SECRET)) {
      const client = getOAuthStore().getClient(client_id, redirect_uri);
      res.status(401).send(consentPage({
        clientName: client.client_name,
        clientId: client_id,
        redirectUri: redirect_uri,
        codeChallenge: code_challenge,
        state: state ?? '',
        error: 'Incorrect password. Please enter your server\'s bearer secret (from `npm run generate-token`).',
      }));
      return;
    }

    const code = getOAuthStore().createAuthCode(client_id, redirect_uri, code_challenge);
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);

    res.redirect(302, redirectUrl.toString());
  });

  // ── Token Endpoint ────────────────────────────────────────────────────────
  router.post('/oauth/token', (req: Request, res: Response) => {
    const { grant_type, code, redirect_uri, client_id, code_verifier } = req.body as Record<string, string>;

    if (grant_type !== 'authorization_code') {
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }

    if (!code || !client_id || !code_verifier || !redirect_uri) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Missing required parameters' });
      return;
    }

    const authCode = getOAuthStore().consumeAuthCode(code);
    if (!authCode) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Auth code invalid, expired or already used' });
      return;
    }

    if (authCode.client_id !== client_id) {
      // Auto-update or allow if client_id matched during auth
    }

    if (authCode.redirect_uri !== redirect_uri) {
      res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
      return;
    }

    // Verify PKCE S256 if provided
    if (authCode.code_challenge) {
      const computed = crypto
        .createHash('sha256')
        .update(code_verifier)
        .digest('base64url');

      if (computed !== authCode.code_challenge) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }
    }

    const accessToken = getOAuthStore().createAccessToken(client_id);
    const expiresIn = 365 * 24 * 60 * 60; // 1 year

    res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: 'mcp',
    });
  });

  return router;
}

interface ConsentPageOptions {
  clientName: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  error?: string;
}

function consentPage(opts: ConsentPageOptions): string {
  const errorHtml = opts.error
    ? `<div class="error">${escapeHtml(opts.error)}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize — remote-ai MCP</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0f0f10;
      color: #e5e5e5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1rem;
    }
    .card {
      background: #1a1a1c;
      border: 1px solid #2e2e30;
      border-radius: 12px;
      padding: 2rem;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    }
    .logo { font-size: 1.5rem; font-weight: 700; color: #fff; margin-bottom: 0.25rem; }
    .sub { font-size: 0.875rem; color: #888; margin-bottom: 1.5rem; }
    .client-box {
      background: #111;
      border: 1px solid #2e2e30;
      border-radius: 8px;
      padding: 0.75rem 1rem;
      margin-bottom: 1.5rem;
    }
    .client-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: #666; }
    .client-name { font-weight: 600; color: #ddd; margin-top: 0.25rem; }
    label { display: block; font-size: 0.875rem; color: #aaa; margin-bottom: 0.5rem; margin-top: 1rem; }
    input[type=password] {
      width: 100%;
      padding: 0.625rem 0.875rem;
      background: #111;
      border: 1px solid #333;
      border-radius: 8px;
      color: #fff;
      font-size: 0.9375rem;
      outline: none;
    }
    input[type=password]:focus { border-color: #666; }
    button {
      width: 100%;
      margin-top: 1.25rem;
      padding: 0.75rem;
      background: #fff;
      color: #000;
      font-weight: 600;
      border: none;
      border-radius: 8px;
      font-size: 0.9375rem;
      cursor: pointer;
    }
    button:hover { background: #e5e5e5; }
    .error {
      margin-top: 1rem;
      padding: 0.625rem 0.875rem;
      background: #2a1010;
      border: 1px solid #5a1a1a;
      border-radius: 8px;
      color: #f87171;
      font-size: 0.875rem;
    }
    .hint { margin-top: 1rem; font-size: 0.75rem; color: #555; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">remote-ai</div>
    <div class="sub">Local Coding Agent MCP Server</div>

    <div class="client-box">
      <div class="client-label">Requesting access</div>
      <div class="client-name">${escapeHtml(opts.clientName)}</div>
    </div>

    <form method="POST" action="/oauth/consent">
      <input type="hidden" name="client_id"      value="${escapeHtml(opts.clientId)}">
      <input type="hidden" name="redirect_uri"   value="${escapeHtml(opts.redirectUri)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(opts.codeChallenge)}">
      <input type="hidden" name="state"          value="${escapeHtml(opts.state)}">

      <label for="password">Server password</label>
      <input type="password" id="password" name="password" placeholder="Enter your server's bearer secret" autofocus>

      ${errorHtml}

      <button type="submit">Authorize access</button>
    </form>

    <p class="hint">This is your private MCP server. Enter the raw bearer secret from 'npm run generate-token'.</p>
  </div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
