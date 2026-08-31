import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withAudit } from '../audit.js';
import { registerProfileTool } from '../tool-registry.js';

export function registerInteractionTools(server: McpServer): void {
  registerProfileTool(
    server,
    'ask_user_question',
    'Ask the user a clarifying question with options before proceeding. Use to resolve ambiguity before destructive operations.',
    {
      question: z.string().min(1).describe('The clarifying question to ask'),
      options: z.array(z.string()).min(2).max(6).describe('2-6 answer options to present to the user'),
    },
    async ({ question, options }) => {
      return withAudit('ask_user_question', { question }, async () => {
        const formatted = options.map((opt: string, i: number) => `  ${i + 1}. ${opt}`).join('\n');
        return {
          content: [{
            type: 'text' as const,
            text: [
              '❓ Question for user:',
              '',
              question,
              '',
              'Options:',
              formatted,
              '',
              '(Please reply with your choice number or free-form answer)',
            ].join('\n'),
          }],
        };
      });
    },
    { isWrite: false }
  );
}
