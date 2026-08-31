import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z, ZodRawShape, ZodObject } from 'zod';
import { config } from './config.js';

export interface RegisterToolOptions {
  isWrite?: boolean;
}

export interface ToolDefinition {
  name: string;
  description: string;
  schema: ZodRawShape;
  zodObject: ZodObject<ZodRawShape>;
  handler: (args: any) => Promise<any>;
  isWrite: boolean;
}

export const registeredTools = new Map<string, ToolDefinition>();

/**
 * Helper to register tools with McpServer respecting MCP_TOOL_PROFILE and saving to REST/OpenAPI registry.
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
    return;
  }

  let finalDescription = description;
  if (profile === 'compat-readonly-all' && isWrite) {
    finalDescription = `[readOnlyHint: true] ${description}`;
  }

  const zodObj = z.object(schema);

  registeredTools.set(name, {
    name,
    description: finalDescription,
    schema,
    zodObject: zodObj,
    handler: handler as any,
    isWrite,
  });

  server.tool(name, finalDescription, schema, handler as any);
}
