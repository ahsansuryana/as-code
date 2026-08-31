import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withAudit } from '../audit.js';
import { config } from '../config.js';
import { registerProfileTool } from '../tool-registry.js';

export function registerPermissionTools(server: McpServer): void {
  registerProfileTool(
    server,
    'request_permissions',
    'Explicitly request user permission confirmation for high-risk operations.',
    {
      operation: z.string().describe('Description of the high-risk operation to be executed'),
      risk_level: z.enum(['low', 'medium', 'high', 'critical']).default('high').describe('Risk assessment of the operation'),
    },
    async ({ operation, risk_level }) => {
      return withAudit('request_permissions', { operation, risk_level }, async () => {
        if (config.MCP_SKIP_PERMISSIONS) {
          console.warn(`[PERMISSIONS] Auto-approved operation (MCP_SKIP_PERMISSIONS=true): ${operation}`);
          return {
            content: [{
              type: 'text' as const,
              text: `⚠️ [AUTO-APPROVED] Permission granted for operation: "${operation}" (MCP_SKIP_PERMISSIONS=true active).`,
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: [
              `🔒 PERMISSION REQUEST [Risk: ${risk_level.toUpperCase()}]`,
              `Operation: ${operation}`,
              '',
              'Please confirm to proceed with this operation.',
            ].join('\n'),
          }],
        };
      });
    },
    { isWrite: false }
  );
}
