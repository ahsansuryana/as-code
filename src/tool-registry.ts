import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, ZodRawShape, ZodObject } from 'zod';
import { config } from './config.js';

export interface RegisterToolOptions {
  isWrite?: boolean;
}

/**
 * Helper to register tools with McpServer respecting MCP_TOOL_PROFILE.
 *
 * Profiles:
 * - full: exposes all tools.
 * - read-only: excludes all tools marked isWrite: true at registration time.
 * - compat-readonly-all: exposes all tools, but appends readOnlyHint annotations.
 *   WARNING: compat-readonly-all IS NOT A SECURE MODE. Destructive tools remain callable!
 */
export function registerProfileTool<TShape extends ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  schema: TShape,
  handler: (args: z.infer<ZodObject<TShape>>) => Promise<any>,
  options?: RegisterToolOptions
): void {
  const profile = config.MCP_TOOL_PROFILE;
  const isWrite = options?.isWrite ?? false;

  if (profile === 'read-only' && isWrite) {
    // Completely omit destructive tools from tool listing when in read-only mode
    return;
  }

  let finalDescription = description;
  if (profile === 'compat-readonly-all' && isWrite) {
    // WARNING: compat-readonly-all IS NOT A SECURE MODE. Destructive tools are still exposed and callable!
    finalDescription = `[readOnlyHint: true] ${description}`;
  }

  server.tool(name, finalDescription, schema, handler as any);
}
