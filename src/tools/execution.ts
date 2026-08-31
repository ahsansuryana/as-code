import { z } from 'zod';
import { spawn, execSync } from 'child_process';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveSafePath, validateCommandAllowlist } from '../security.js';
import { withAudit } from '../audit.js';
import { config } from '../config.js';

export function registerExecutionTools(server: McpServer): void {
  server.tool(
    'run_command',
    'Execute a shell command inside PROJECT_ROOT. Only allowlisted executables are permitted. Always requires approval.',
    {
      command: z.string().describe('Shell command to execute (executable must be in allowlist)'),
      timeout_ms: z
        .number()
        .int()
        .min(1000)
        .optional()
        .describe(`Timeout in ms (default: 120000, ceiling: ${config.COMMAND_TIMEOUT_CEILING_MS})`),
      working_dir: z
        .string()
        .optional()
        .describe('Working directory (relative to PROJECT_ROOT or absolute within PROJECT_ROOT)'),
    },
    async ({ command, timeout_ms, working_dir }) => {
      return withAudit('run_command', { command, timeout_ms, working_dir }, async () => {
        validateCommandAllowlist(command);

        const cwd = working_dir
          ? resolveSafePath(working_dir)
          : path.resolve(config.PROJECT_ROOT);

        const timeout = Math.min(
          timeout_ms ?? 120_000,
          config.COMMAND_TIMEOUT_CEILING_MS
        );

        const result = await runShellCommand(command, cwd, timeout);

        const lines = [
          `$ ${command}`,
          `Exit code: ${result.exitCode}`,
          `Duration: ${result.durationMs}ms`,
          '',
        ];
        if (result.stdout) lines.push('STDOUT:', result.stdout.slice(0, 8000));
        if (result.stderr) lines.push('STDERR:', result.stderr.slice(0, 2000));
        if (result.timedOut) lines.push(`\u26a0\ufe0f Command timed out after ${timeout}ms`);

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      });
    }
  );

  server.tool(
    'git_status',
    'Show the working tree status (git status). Read-only.',
    {
      path: z.string().optional().describe('Path within the project (defaults to PROJECT_ROOT)'),
    },
    async ({ path: userPath }) => {
      return withAudit('git_status', { path: userPath }, async () => {
        const cwd = userPath ? resolveSafePath(userPath) : path.resolve(config.PROJECT_ROOT);
        const result = runGitCommand('git status --short --branch', cwd);
        return { content: [{ type: 'text' as const, text: result }] };
      });
    }
  );

  server.tool(
    'git_diff',
    'Show changes in the working tree or between commits. Read-only.',
    {
      path: z.string().optional().describe('Path or file to diff (defaults to PROJECT_ROOT)'),
      args: z.string().optional().describe('Extra git diff arguments, e.g. "HEAD~1" or "--cached"'),
    },
    async ({ path: userPath, args }) => {
      return withAudit('git_diff', { path: userPath, args }, async () => {
        const cwd = userPath ? resolveSafePath(userPath) : path.resolve(config.PROJECT_ROOT);
        const safeArgs = sanitizeGitArgs(args ?? '');
        const result = runGitCommand(`git diff ${safeArgs}`, cwd);
        return { content: [{ type: 'text' as const, text: result || '(no changes)' }] };
      });
    }
  );

  server.tool(
    'git_commit',
    'Stage specified files (or all changes) and create a commit. No force-push or --amend allowed.',
    {
      message: z.string().min(1).describe('Commit message'),
      files: z
        .array(z.string())
        .optional()
        .describe('Files to stage. If empty, stages all changes (git add -A)'),
    },
    async ({ message, files }) => {
      return withAudit('git_commit', { message, files }, async () => {
        const cwd = path.resolve(config.PROJECT_ROOT);

        if (/--force|--amend|--squash/.test(message)) {
          throw new Error('Commit message contains forbidden flags');
        }

        if (files && files.length > 0) {
          const resolvedFiles = files.map(f => resolveSafePath(f));
          const addResult = await runShellCommand(
            `git add ${resolvedFiles.map(f => `"${f}"`).join(' ')}`,
            cwd,
            30_000
          );
          if (addResult.exitCode !== 0) {
            throw new Error(`git add failed: ${addResult.stderr}`);
          }
        } else {
          const addResult = await runShellCommand('git add -A', cwd, 30_000);
          if (addResult.exitCode !== 0) {
            throw new Error(`git add -A failed: ${addResult.stderr}`);
          }
        }

        const commitResult = await runShellCommand(
          `git commit -m ${JSON.stringify(message)}`,
          cwd,
          30_000
        );

        if (commitResult.exitCode !== 0) {
          throw new Error(`git commit failed: ${commitResult.stderr}`);
        }

        return {
          content: [{
            type: 'text' as const,
            text: `\u2705 Committed\n${commitResult.stdout}`,
          }],
        };
      });
    }
  );
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

function runShellCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandResult> {
  return new Promise(resolve => {
    const start = Date.now();
    let timedOut = false;
    let stdout = '';
    let stderr = '';

    const proc = spawn(command, [], {
      shell: true,
      cwd,
      env: { ...process.env, PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });

    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
    }, timeoutMs);

    proc.on('close', exitCode => {
      clearTimeout(timer);
      resolve({
        exitCode: exitCode ?? -1,
        stdout: stdout.trimEnd(),
        stderr: stderr.trimEnd(),
        durationMs: Date.now() - start,
        timedOut,
      });
    });
  });
}

function runGitCommand(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, encoding: 'utf-8', timeout: 15_000 }).trimEnd();
  } catch (err: unknown) {
    const e = err as { message?: string; stderr?: Buffer };
    throw new Error(`Git command failed: ${e.stderr?.toString() ?? e.message}`);
  }
}

function sanitizeGitArgs(args: string): string {
  const forbidden = /--exec|--upload-pack|--receive-pack|`|\$\(|;|&&|\|\|/;
  if (forbidden.test(args)) {
    throw new Error(`Forbidden characters in git args: "${args}"`);
  }
  return args;
}
