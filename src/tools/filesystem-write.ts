import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveSafePath } from '../security.js';
import { withAudit } from '../audit.js';
import { markFileAsRead, hasFileBeenRead } from '../session-state.js';
import { registerProfileTool } from '../tool-registry.js';

export function registerFilesystemWriteTools(server: McpServer): void {
  registerProfileTool(
    server,
    'write_file',
    'Create or overwrite a file. Edits the file in place — no backup is created.',
    {
      path: z.string().describe('File path (absolute or relative to PROJECT_ROOT)'),
      content: z.string().describe('Full file content to write'),
    },
    async ({ path: userPath, content }) => {
      return withAudit('write_file', { path: userPath, content_length: content.length }, async () => {
        const filePath = resolveSafePath(userPath);
        const parentDir = path.dirname(filePath);

        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        const existed = fs.existsSync(filePath);

        fs.writeFileSync(filePath, content, 'utf-8');
        markFileAsRead(filePath);

        return {
          content: [{
            type: 'text' as const,
            text: [
              `✅ Written: ${filePath}`,
              existed ? '(overwritten)' : '(new file)',
              `Bytes written: ${Buffer.byteLength(content, 'utf-8')}`,
            ].join('\n'),
          }],
        };
      });
    },
    { isWrite: true }
  );

  registerProfileTool(
    server,
    'edit_file',
    'Edit a file by replacing exact string occurrences. The file must have been read first in this session to prevent blind edits.',
    {
      path: z.string().describe('File path (absolute or relative to PROJECT_ROOT)'),
      old_string: z.string().describe('Exact string to find and replace'),
      new_string: z.string().describe('Replacement string'),
      replace_all: z.boolean().default(false).describe('If true, replace all occurrences; if false (default), fail if not exactly one match'),
    },
    async ({ path: userPath, old_string, new_string, replace_all }) => {
      return withAudit('edit_file', { path: userPath, old_string_preview: old_string.slice(0, 80) }, async () => {
        const filePath = resolveSafePath(userPath);

        if (!hasFileBeenRead(filePath)) {
          throw new Error(
            `Blind edit blocked: "${filePath}" has not been read in this session. Call read_file first.`
          );
        }

        if (!fs.existsSync(filePath)) {
          throw new Error(`File not found: ${filePath}`);
        }

        const original = fs.readFileSync(filePath, 'utf-8');
        const occurrences = countOccurrences(original, old_string);

        if (occurrences === 0) {
          throw new Error(`old_string not found in file. No changes made.\n\nSearch string:\n${old_string}`);
        }
        if (!replace_all && occurrences > 1) {
          throw new Error(
            `Ambiguous match: old_string appears ${occurrences} times. Use replace_all: true or provide more context.`
          );
        }

        const updated = replace_all
          ? original.split(old_string).join(new_string)
          : original.replace(old_string, new_string);

        fs.writeFileSync(filePath, updated, 'utf-8');

        return {
          content: [{
            type: 'text' as const,
            text: [
              `✅ Edited: ${filePath}`,
              `Replaced ${replace_all ? occurrences : 1} occurrence(s)`,
            ].join('\n'),
          }],
        };
      });
    },
    { isWrite: true }
  );
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++;
    pos += needle.length;
  }
  return count;
}
