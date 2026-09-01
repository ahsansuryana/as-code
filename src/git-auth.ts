import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const GIT_ASKPASS_PATH = fileURLToPath(new URL('../scripts/git-askpass.mjs', import.meta.url));

/**
 * Returns environment variables needed for authenticated HTTPS Git commands.
 * Credentials are only injected into processes that are explicitly running Git.
 * The askpass helper is an executable script with a Node shebang; Git expects
 * GIT_ASKPASS to name the program, not a shell command plus arguments. The path
 * is resolved relative to this module so compiled and source execution both work.
 */
export function getGitEnvironment(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!config.GIT_USER || !config.GIT_PAT) return baseEnv;

  return {
    ...baseEnv,
    GIT_ASKPASS: GIT_ASKPASS_PATH,
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
