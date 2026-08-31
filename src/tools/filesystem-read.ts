import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveSafePath } from '../security.js';
import { withAudit } from '../audit.js';
import { config } from '../config.js';
import { markFileAsRead } from '../session-state.js';

export const DEFAULT_EXCLUDES = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
];

export function isIgnoredPath(name: string, includeIgnored: boolean): boolean {
  if (includeIgnored) return false;
  if (name.startsWith('.')) return true;
  return DEFAULT_EXCLUDES.includes(name);
}

export function registerFilesystemReadTools(server: McpServer): void {
  server.tool(
    'read_file',
    'Read the contents of a file. Returns content with line numbers. Supports pagination via offset/limit.',
    {
      path: z.string().describe('Path to the file (absolute or relative to PROJECT_ROOT)'),
      offset: z.number().int().min(1).optional().describe('Start from this line number (1-indexed)'),
      limit: z.number().int().min(1).max(5000).optional().describe('Maximum number of lines to return'),
    },
    async ({ path: userPath, offset, limit }) => {
      return withAudit('read_file', { path: userPath, offset, limit }, async () => {
        const filePath = resolveSafePath(userPath);

        if (!fs.existsSync(filePath)) {
          throw new Error(`File not found: ${filePath}`);
        }

        const stat = fs.statSync(filePath);
        if (!stat.isFile()) {
          throw new Error(`Not a file: ${filePath}`);
        }

        const raw = fs.readFileSync(filePath, 'utf-8');
        let lines = raw.split('\n');
        const totalLines = lines.length;

        const startIdx = (offset ?? 1) - 1;
        if (limit !== undefined) {
          lines = lines.slice(startIdx, startIdx + limit);
        } else if (offset !== undefined) {
          lines = lines.slice(startIdx);
        }

        const startLineNum = startIdx + 1;
        const numbered = lines
          .map((line, i) => `${String(startLineNum + i).padStart(6)} | ${line}`)
          .join('\n');

        const truncated = limit !== undefined || offset !== undefined;
        const showing = `lines ${startLineNum}\u2013${startLineNum + lines.length - 1} of ${totalLines}`;

        markFileAsRead(filePath);

        return {
          content: [{
            type: 'text' as const,
            text: [
              `File: ${filePath}`,
              truncated ? `Showing ${showing}` : `Total: ${totalLines} lines`,
              '```',
              numbered,
              '```',
            ].join('\n'),
          }],
        };
      });
    }
  );

  server.tool(
    'list_dir',
    'List the contents of a directory.',
    {
      path: z.string().describe('Directory path (absolute or relative to PROJECT_ROOT)'),
      include_ignored: z.boolean().default(false).describe('Set to true to include node_modules, .git, etc.'),
    },
    async ({ path: userPath, include_ignored }) => {
      return withAudit('list_dir', { path: userPath, include_ignored }, async () => {
        const dirPath = resolveSafePath(userPath);

        if (!fs.existsSync(dirPath)) {
          throw new Error(`Directory not found: ${dirPath}`);
        }

        const stat = fs.statSync(dirPath);
        if (!stat.isDirectory()) {
          throw new Error(`Not a directory: ${dirPath}`);
        }

        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        const lines = entries
          .filter(e => !isIgnoredPath(e.name, include_ignored))
          .sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
          })
          .map(entry => {
            const icon = entry.isDirectory() ? '📁' : '📄';
            const entryPath = path.join(dirPath, entry.name);
            let extra = '';
            if (entry.isFile()) {
              try {
                const size = fs.statSync(entryPath).size;
                extra = ` (${formatBytes(size)})`;
              } catch { /* ignore */ }
            }
            return `${icon} ${entry.name}${extra}`;
          });

        return {
          content: [{
            type: 'text' as const,
            text: `Directory: ${dirPath}\n\n${lines.join('\n')}`,
          }],
        };
      });
    }
  );

  server.tool(
    'glob_search',
    'Find files matching a glob pattern. Results sorted by modification time (newest first), capped at 100.',
    {
      pattern: z.string().describe('Glob pattern, e.g. src/**/*.ts'),
      path: z.string().optional().describe('Root directory for the search (defaults to PROJECT_ROOT)'),
      include_ignored: z.boolean().default(false).describe('Set to true to search inside node_modules, build dirs, etc.'),
    },
    async ({ pattern, path: userPath, include_ignored }) => {
      return withAudit('glob_search', { pattern, path: userPath, include_ignored }, async () => {
        const searchRoot = userPath ? resolveSafePath(userPath) : path.resolve(config.PROJECT_ROOT);
        const results = globSync(pattern, searchRoot, 100, include_ignored);

        if (results.length === 0) {
          return { content: [{ type: 'text' as const, text: `No files found matching: ${pattern}` }] };
        }

        const lines = results.map(r => `${r.mtime.toISOString().slice(0, 16)}  ${r.relPath}`);
        return {
          content: [{
            type: 'text' as const,
            text: `Found ${results.length} file(s) matching "${pattern}" in ${searchRoot}:\n\n${lines.join('\n')}`,
          }],
        };
      });
    }
  );

  server.tool(
    'grep_search',
    'Search file contents using regex patterns. Returns matching files or content with line numbers.',
    {
      pattern: z.string().describe('Regex pattern to search for'),
      path: z.string().optional().describe('Directory or file to search in (defaults to PROJECT_ROOT)'),
      glob: z.string().optional().describe('File filter glob, e.g. **/*.ts'),
      output_mode: z
        .enum(['files_with_matches', 'content', 'count'])
        .default('content')
        .describe('Output format: list files, show matching lines, or count per file'),
      include_ignored: z.boolean().default(false).describe('Set to true to grep inside node_modules, build dirs, etc.'),
    },
    async ({ pattern, path: userPath, glob: globFilter, output_mode, include_ignored }) => {
      return withAudit('grep_search', { pattern, path: userPath, glob: globFilter, output_mode, include_ignored }, async () => {
        const searchRoot = userPath ? resolveSafePath(userPath) : path.resolve(config.PROJECT_ROOT);
        const results = grepFiles(pattern, searchRoot, globFilter, output_mode, 200, include_ignored);

        if (results.trim() === '') {
          return { content: [{ type: 'text' as const, text: `No matches for pattern: ${pattern}` }] };
        }

        return { content: [{ type: 'text' as const, text: results }] };
      });
    }
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

interface GlobResult {
  absPath: string;
  relPath: string;
  mtime: Date;
}

function globSync(pattern: string, root: string, maxResults: number, includeIgnored: boolean): GlobResult[] {
  const results: GlobResult[] = [];
  const regex = globToRegex(pattern);
  walkDir(root, root, regex, results, maxResults, includeIgnored);
  results.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return results;
}

function walkDir(
  absDir: string,
  root: string,
  regex: RegExp,
  results: GlobResult[],
  max: number,
  includeIgnored: boolean
): void {
  if (results.length >= max) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= max) break;
    if (isIgnoredPath(entry.name, includeIgnored)) continue;
    const absPath = path.join(absDir, entry.name);
    const relPath = path.relative(root, absPath).replace(/\\\\/g, '/');
    if (entry.isDirectory()) {
      walkDir(absPath, root, regex, results, max, includeIgnored);
    } else if (entry.isFile() && regex.test(relPath)) {
      try {
        const stat = fs.statSync(absPath);
        results.push({ absPath, relPath, mtime: stat.mtime });
      } catch { /* ignore */ }
    }
  }
}

function globToRegex(pattern: string): RegExp {
  let regStr = '^';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (pattern.slice(i, i + 2) === '**') {
      regStr += '.*';
      i += 2;
      if (pattern[i] === '/') i++;
    } else if (ch === '*') {
      regStr += '[^/]*';
      i++;
    } else if (ch === '?') {
      regStr += '[^/]';
      i++;
    } else if (ch === '.') {
      regStr += '\\.';
      i++;
    } else {
      regStr += ch.replace(/[$()+{}|[\]^]/g, '\\$&');
      i++;
    }
  }
  regStr += '$';
  return new RegExp(regStr);
}

function grepFiles(
  pattern: string,
  root: string,
  globFilter: string | undefined,
  mode: 'files_with_matches' | 'content' | 'count',
  maxMatches: number,
  includeIgnored: boolean
): string {
  const fileRegex = globFilter ? globToRegex(globFilter) : null;
  const lines: string[] = [];
  let totalMatches = 0;

  function walk(dir: string): void {
    if (totalMatches >= maxMatches) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (totalMatches >= maxMatches) break;
      if (isIgnoredPath(entry.name, includeIgnored)) continue;
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absPath);
      } else if (entry.isFile()) {
        const relPath = path.relative(root, absPath).replace(/\\\\/g, '/');
        if (fileRegex && !fileRegex.test(relPath)) continue;
        try {
          const content = fs.readFileSync(absPath, 'utf-8');
          const fileLines = content.split('\n');
          const matches: Array<{ lineNum: number; text: string }> = [];
          fileLines.forEach((line, idx) => {
            if (new RegExp(pattern).test(line)) {
              matches.push({ lineNum: idx + 1, text: line });
            }
          });
          if (matches.length === 0) return;

          if (mode === 'files_with_matches') {
            lines.push(relPath);
            totalMatches++;
          } else if (mode === 'count') {
            lines.push(`${relPath}: ${matches.length}`);
            totalMatches++;
          } else {
            lines.push(`\n--- ${relPath} ---`);
            for (const m of matches) {
              lines.push(`  ${String(m.lineNum).padStart(4)}: ${m.text}`);
              totalMatches++;
              if (totalMatches >= maxMatches) break;
            }
          }
        } catch { /* binary/unreadable */ }
      }
    }
  }

  walk(root);
  if (totalMatches >= maxMatches) {
    lines.push(`\n[Output truncated at ${maxMatches} matches]`);
  }
  return lines.join('\n');
}
