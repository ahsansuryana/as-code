import { z } from 'zod';
import { spawn, execSync } from 'child_process';
import path from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { resolveSafePath, validateCommandAllowlist } from '../security.js';
import { withAudit } from '../audit.js';
import { config } from '../config.js';
import { getGitEnvironment, isGitCommand } from '../git-auth.js';
import { registerProfileTool } from '../tool-registry.js';
import {
  createExecutionSession,
  writeSessionStdin,
  readSessionOutput,
  killExecutionSession,
  listExecutionSessions,
  getDefaultCwd,
} from '../session-manager.js';

export function registerExecutionSessionTools(server: McpServer): void {
  // ─── exec_command ─────────────────────────────────────────────────────────
  registerProfileTool(
    server,
    'exec_command',
    'Execute a shell command. Supports blocking mode (default) or background mode (returns session_id immediately).',
    {
      command: z.string().describe('Shell command to execute (executable must be in allowlist)'),
      background: z.boolean().default(false).describe('If true, launches as background session and returns session_id immediately'),
      timeout_ms: z.number().int().min(1000).optional().describe(`Timeout in ms for blocking execution (ceiling: ${config.COMMAND_TIMEOUT_CEILING_MS})`),
      cwd: z.string().optional().describe('Working directory relative to PROJECT_ROOT (defaults to session default CWD)'),
    },
    async ({ command, background, timeout_ms, cwd: userCwd }) => {
      return withAudit('exec_command', { command, background, timeout_ms, cwd: userCwd }, async () => {
        validateCommandAllowlist(command);

        const relCwd = userCwd ?? getDefaultCwd();
        const cwdPath = resolveSafePath(relCwd);

        if (background) {
          const timeout = timeout_ms ?? config.SESSION_WATCHDOG_TIMEOUT_MS;
          const session = createExecutionSession(command, cwdPath, timeout);
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                session_id: session.id,
                status: session.status,
                command: session.command,
                message: 'Background session launched successfully. Use read_session_output or write_stdin to interact.',
              }, null, 2),
            }],
          };
        }

        // Blocking mode
        const timeout = Math.min(timeout_ms ?? 120_000, config.COMMAND_TIMEOUT_CEILING_MS);
        const result = await runShellCommand(command, cwdPath, timeout);

        const lines = [
          `$ ${command}`,
          `Exit code: ${result.exitCode}`,
          `Duration: ${result.durationMs}ms`,
          '',
        ];
        if (result.stdout) lines.push('STDOUT:', result.stdout.slice(0, 8000));
        if (result.stderr) lines.push('STDERR:', result.stderr.slice(0, 2000));
        if (result.timedOut) lines.push(`⚠️ Command timed out after ${timeout}ms`);

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      });
    },
    { isWrite: true }
  );

  // ─── run_command (legacy alias) ───────────────────────────────────────────
  registerProfileTool(
    server,
    'run_command',
    'Legacy command execution (blocking mode). Wrapper over exec_command.',
    {
      command: z.string().describe('Shell command to execute'),
      timeout_ms: z.number().int().optional().describe('Timeout in ms'),
      working_dir: z.string().optional().describe('Working directory'),
    },
    async ({ command, timeout_ms, working_dir }) => {
      return withAudit('run_command', { command, timeout_ms, working_dir }, async () => {
        validateCommandAllowlist(command);
        const relCwd = working_dir ?? getDefaultCwd();
        const cwdPath = resolveSafePath(relCwd);
        const timeout = Math.min(timeout_ms ?? 120_000, config.COMMAND_TIMEOUT_CEILING_MS);

        const result = await runShellCommand(command, cwdPath, timeout);
        const lines = [
          `$ ${command}`,
          `Exit code: ${result.exitCode}`,
          `Duration: ${result.durationMs}ms`,
          '',
        ];
        if (result.stdout) lines.push('STDOUT:', result.stdout.slice(0, 8000));
        if (result.stderr) lines.push('STDERR:', result.stderr.slice(0, 2000));

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      });
    },
    { isWrite: true }
  );

  // ─── write_stdin ──────────────────────────────────────────────────────────
  registerProfileTool(
    server,
    'write_stdin',
    'Write text input to the stdin of an active background execution session.',
    {
      session_id: z.string().describe('ID of the target running background session'),
      input: z.string().describe('Text/command string to send to stdin'),
      append_newline: z.boolean().default(true).describe('If true (default), appends newline (\\n) to input'),
    },
    async ({ session_id, input, append_newline }) => {
      return withAudit('write_stdin', { session_id, input_len: input.length, append_newline }, async () => {
        writeSessionStdin(session_id, input, append_newline);
        return {
          content: [{
            type: 'text' as const,
            text: `✅ Sent input to stdin of session ${session_id}`,
          }],
        };
      });
    },
    { isWrite: true }
  );

  // ─── read_session_output ──────────────────────────────────────────────────
  registerProfileTool(
    server,
    'read_session_output',
    'Read the current stdout and stderr output from a background execution session without stopping it.',
    {
      session_id: z.string().describe('ID of the target background session'),
      since_offset: z.number().int().min(0).default(0).describe('Byte offset for incremental read'),
    },
    async ({ session_id, since_offset }) => {
      return withAudit('read_session_output', { session_id, since_offset }, async () => {
        const output = readSessionOutput(session_id, since_offset);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(output, null, 2),
          }],
        };
      });
    },
    { isWrite: false }
  );

  // ─── kill_session ─────────────────────────────────────────────────────────
  registerProfileTool(
    server,
    'kill_session',
    'Force kill a background execution session and its child process tree.',
    {
      session_id: z.string().describe('ID of the background session to kill'),
      signal: z.enum(['SIGTERM', 'SIGKILL']).default('SIGTERM').describe('Signal to send (SIGTERM or SIGKILL)'),
    },
    async ({ session_id, signal }) => {
      return withAudit('kill_session', { session_id, signal }, async () => {
        killExecutionSession(session_id, signal);
        return {
          content: [{
            type: 'text' as const,
            text: `🛑 Killed background session ${session_id} (signal: ${signal})`,
          }],
        };
      });
    },
    { isWrite: true }
  );

  // ─── list_sessions ────────────────────────────────────────────────────────
  registerProfileTool(
    server,
    'list_sessions',
    'List all background execution sessions and their status.',
    {},
    async () => {
      return withAudit('list_sessions', {}, async () => {
        const sessionsList = listExecutionSessions();
        if (sessionsList.length === 0) {
          return { content: [{ type: 'text' as const, text: 'No background execution sessions.' }] };
        }
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(sessionsList, null, 2),
          }],
        };
      });
    },
    { isWrite: false }
  );

  // ─── git_status ───────────────────────────────────────────────────────────
  registerProfileTool(
    server,
    'git_status',
    'Show the working tree status (git status). Read-only.',
    {
      path: z.string().optional().describe('Path within the project (defaults to session CWD)'),
    },
    async ({ path: userPath }) => {
      return withAudit('git_status', { path: userPath }, async () => {
        const relCwd = userPath ?? getDefaultCwd();
        const cwd = resolveSafePath(relCwd);
        const result = runGitCommand('git status --short --branch', cwd);
        return { content: [{ type: 'text' as const, text: result }] };
      });
    },
    { isWrite: false }
  );

  // ─── git_diff ─────────────────────────────────────────────────────────────
  registerProfileTool(
    server,
    'git_diff',
    'Show changes in the working tree or between commits (git diff). Read-only.',
    {
      path: z.string().optional().describe('Path or file to diff (defaults to session CWD)'),
      args: z.string().optional().describe('Extra git diff arguments, e.g. "HEAD~1" or "--cached"'),
    },
    async ({ path: userPath, args }) => {
      return withAudit('git_diff', { path: userPath, args }, async () => {
        const relCwd = userPath ?? getDefaultCwd();
        const cwd = resolveSafePath(relCwd);
        const safeArgs = sanitizeGitArgs(args ?? '');
        const result = runGitCommand(`git diff ${safeArgs}`, cwd);
        return { content: [{ type: 'text' as const, text: result || '(no changes)' }] };
      });
    },
    { isWrite: false }
  );

  // ─── git_commit ───────────────────────────────────────────────────────────
  registerProfileTool(
    server,
    'git_commit',
    'Stage specified files (or all changes) and create a commit. No force-push or --amend allowed.',
    {
      message: z.string().min(1).describe('Commit message'),
      files: z.array(z.string()).optional().describe('Files to stage. If empty, stages all changes (git add -A)'),
    },
    async ({ message, files }) => {
      return withAudit('git_commit', { message, files }, async () => {
        const cwd = resolveSafePath(getDefaultCwd());

        if (/--force|--amend|--squash/.test(message)) {
          throw new Error('Commit message contains forbidden flags');
        }

        if (files && files.length > 0) {
          const resolvedFiles = files.map((f: string) => resolveSafePath(f));
          const addResult = await runShellCommand(
            `git add ${resolvedFiles.map((f: string) => `"${f}"`).join(' ')}`,
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
            text: `✅ Committed\n${commitResult.stdout}`,
          }],
        };
      });
    },
    { isWrite: true }
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

    const baseEnv = { ...process.env, PATH: process.env.PATH ?? '/usr/bin:/bin' };
    // Pass Git credentials through the shell environment. Git's askpass helper
    // is inherited by Git even when the command is executed via `sh -c`.
    const env = isGitCommand(command) ? getGitEnvironment(baseEnv) : baseEnv;
    const proc = spawn(command, [], {
      shell: true,
      cwd,
      env,
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
    return execSync(cmd, {
      cwd,
      encoding: 'utf-8',
      timeout: 15_000,
      env: getGitEnvironment({ ...process.env, PATH: process.env.PATH ?? '/usr/bin:/bin' }),
    }).trimEnd();
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
