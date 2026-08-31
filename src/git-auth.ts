import path from 'path';
import { config } from './config.js';

/**
 * Returns environment variables needed for authenticated HTTPS Git commands.
 * Credentials are only injected into processes that are explicitly running Git.
 */
export function getGitEnvironment(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!config.GIT_USER || !config.GIT_PAT) return baseEnv;

  return {
    ...baseEnv,
    GIT_ASKPASS: `${process.execPath} "${path.resolve(process.cwd(), 'scripts/git-askpass.mjs')}"`,
    GIT_TERMINAL_PROMPT: '0',
    GIT_USER: config.GIT_USER,
    GIT_PAT: config.GIT_PAT,
    ...(config.GIT_COMMIT_NAME && config.GIT_COMMIT_EMAIL
      ? {
          GIT_AUTHOR_NAME: config.GIT_COMMIT_NAME,
          GIT_AUTHOR_EMAIL: config.GIT_COMMIT_EMAIL,
          GIT_COMMITTER_NAME: config.GIT_COMMIT_NAME,
          GIT_COMMITTER_EMAIL: config.GIT_COMMIT_EMAIL,
        }
      : {}),
  };
}

/**
 * Detect a Git executable in a shell command without treating arbitrary text
 * containing the word "git" as a Git command.
 */
export function isGitCommand(command: string): boolean {
  return /(?:^|[;&|]\s*)(?:git(?:\.exe)?)(?:\s|$)/i.test(command.trim()) || /(?:^|\s)git(?:\.exe)?\s/i.test(command);
}
