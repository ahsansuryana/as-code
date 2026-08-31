import { z } from 'zod';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveSafePath } from '../security.js';
import { withAudit } from '../audit.js';
import { config } from '../config.js';
import { registerProfileTool } from '../tool-registry.js';
import { getDefaultCwd, setDefaultCwd } from '../session-manager.js';

export function registerServerInfoTools(server: McpServer): void {
  // ─── server_info ──────────────────────────────────────────────────────────
  registerProfileTool(
    server,
    'server_info',
    'Get server capabilities, active tool profile, allowed commands, and project context.',
    {},
    async () => {
      return withAudit('server_info', {}, async () => {
        const rootBaseName = path.basename(path.resolve(config.PROJECT_ROOT));
        const info = {
          version: '0.1.0',
          tool_profile: config.MCP_TOOL_PROFILE,
          project_root_name: rootBaseName,
          default_cwd: getDefaultCwd(),
          allowed_commands: config.commandAllowlist,
          has_background_exec: true,
          permission_mode: config.PERMISSION_MODE,
          skip_permissions: config.MCP_SKIP_PERMISSIONS,
        };

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(info, null, 2),
          }],
        };
      });
    },
    { isWrite: false }
  );

  // ─── get_default_cwd ──────────────────────────────────────────────────────
  registerProfileTool(
    server,
    'get_default_cwd',
    'Get the current session default working directory (relative to PROJECT_ROOT).',
    {},
    async () => {
      return withAudit('get_default_cwd', {}, async () => {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ default_cwd: getDefaultCwd() }, null, 2),
          }],
        };
      });
    },
    { isWrite: false }
  );

  // ─── set_default_cwd ──────────────────────────────────────────────────────
  registerProfileTool(
    server,
    'set_default_cwd',
    'Set the default working directory for subsequent command executions (relative to PROJECT_ROOT).',
    {
      path: z.string().describe('Relative directory path within PROJECT_ROOT'),
    },
    async ({ path: relPath }) => {
      return withAudit('set_default_cwd', { path: relPath }, async () => {
        // Validate path is inside PROJECT_ROOT
        const absPath = resolveSafePath(relPath);
        const rootAbs = resolveSafePath('.');
        const normalizedRel = path.relative(rootAbs, absPath).replace(/\\/g, '/') || '.';

        const updated = setDefaultCwd(normalizedRel);

        return {
          content: [{
            type: 'text' as const,
            text: `✅ Default working directory updated to: "${updated}"`,
          }],
        };
      });
    },
    { isWrite: true }
  );
}
