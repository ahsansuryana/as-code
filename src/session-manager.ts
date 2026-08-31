import { spawn, ChildProcess, execSync } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import { config } from './config.js';

export interface ExecutionSession {
  id: string;
  command: string;
  cwd: string;
  status: 'running' | 'exited' | 'killed' | 'timed_out';
  started_at: string;
  pid?: number;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  process?: ChildProcess;
  watchdogTimer?: NodeJS.Timeout;
}

const MAX_BUFFER_BYTES = 1024 * 1024; // 1 MB bounded output buffer
const sessions = new Map<string, ExecutionSession>();

let defaultCwdRel = '.';

export function getDefaultCwd(): string {
  return defaultCwdRel;
}

export function setDefaultCwd(relPath: string): string {
  defaultCwdRel = relPath;
  return defaultCwdRel;
}

export function appendBoundedBuffer(existing: string, newData: string, maxBytes = MAX_BUFFER_BYTES): string {
  const combined = existing + newData;
  if (Buffer.byteLength(combined, 'utf-8') <= maxBytes) {
    return combined;
  }
  // Drop older content from the front
  const buf = Buffer.from(combined, 'utf-8');
  return buf.subarray(buf.length - maxBytes).toString('utf-8');
}

export function createExecutionSession(
  command: string,
  cwd: string,
  timeoutMs: number = config.SESSION_WATCHDOG_TIMEOUT_MS
): ExecutionSession {
  const id = 'sess_' + crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();

  // Spawn child process detached for process group kill capability
  const isWin = process.platform === 'win32';
  const proc = spawn(command, [], {
    shell: true,
    cwd,
    detached: !isWin, // Detached process group on Unix
    env: { ...process.env, PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });

  const session: ExecutionSession = {
    id,
    command,
    cwd,
    status: 'running',
    started_at: now,
    pid: proc.pid,
    exit_code: null,
    stdout: '',
    stderr: '',
    process: proc,
  };

  proc.stdout?.on('data', (data: Buffer) => {
    session.stdout = appendBoundedBuffer(session.stdout, data.toString());
  });

  proc.stderr?.on('data', (data: Buffer) => {
    session.stderr = appendBoundedBuffer(session.stderr, data.toString());
  });

  // Session watchdog timer
  const timer = setTimeout(() => {
    if (session.status === 'running') {
      session.status = 'timed_out';
      killProcessTree(session);
    }
  }, timeoutMs);

  session.watchdogTimer = timer;

  proc.on('close', (code) => {
    clearTimeout(timer);
    if (session.status === 'running') {
      session.status = 'exited';
    }
    session.exit_code = code;
    delete session.process;
  });

  sessions.set(id, session);
  return session;
}

export function writeSessionStdin(sessionId: string, input: string, appendNewline = true): void {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.status !== 'running' || !session.process || !session.process.stdin) {
    throw new Error(`Session ${sessionId} is not currently running (status: ${session.status})`);
  }

  const payload = appendNewline ? input + '\n' : input;
  session.process.stdin.write(payload);
}

export function readSessionOutput(sessionId: string, sinceOffset = 0): {
  id: string;
  status: ExecutionSession['status'];
  exit_code: number | null;
  stdout: string;
  stderr: string;
  stdout_total_bytes: number;
  stderr_total_bytes: number;
} {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const stdoutTotal = Buffer.byteLength(session.stdout, 'utf-8');
  const stderrTotal = Buffer.byteLength(session.stderr, 'utf-8');

  const stdoutSlice = session.stdout.slice(sinceOffset);
  const stderrSlice = session.stderr.slice(sinceOffset);

  return {
    id: session.id,
    status: session.status,
    exit_code: session.exit_code,
    stdout: stdoutSlice,
    stderr: stderrSlice,
    stdout_total_bytes: stdoutTotal,
    stderr_total_bytes: stderrTotal,
  };
}

export function killExecutionSession(sessionId: string, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  if (session.status !== 'running') {
    return; // Already exited/killed
  }

  session.status = 'killed';
  killProcessTree(session, signal);
}

export function listExecutionSessions(): Array<Omit<ExecutionSession, 'process' | 'watchdogTimer'>> {
  return [...sessions.values()].map(s => ({
    id: s.id,
    command: s.command,
    cwd: s.cwd,
    status: s.status,
    started_at: s.started_at,
    pid: s.pid,
    exit_code: s.exit_code,
    stdout: s.stdout.slice(-1000), // Preview last 1000 chars
    stderr: s.stderr.slice(-1000),
  }));
}

function killProcessTree(session: ExecutionSession, signal: 'SIGTERM' | 'SIGKILL' = 'SIGKILL'): void {
  if (session.watchdogTimer) clearTimeout(session.watchdogTimer);
  const pid = session.pid;
  if (!pid) return;

  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /F /T /PID ${pid}`);
    } catch {
      // Process may already be dead
    }
  } else {
    try {
      // Process group kill on Unix
      process.kill(-pid, signal);
    } catch {
      try {
        session.process?.kill(signal);
      } catch {
        // Process may already be dead
      }
    }
  }
}
