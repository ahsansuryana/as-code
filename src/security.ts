import path from 'path';
import fs from 'fs';
import { config } from './config.js';

/**
 * Resolve a user-supplied path and verify it is strictly inside PROJECT_ROOT.
 * Per forms symlink resolution (realpathSync) to prevent symlink escape attempts.
 */
export function resolveSafePath(userPath: string): string {
  const projectRoot = path.resolve(config.PROJECT_ROOT);
  
  // Resolve symlinks on projectRoot if it exists
  const realProjectRoot = fs.existsSync(projectRoot) 
    ? fs.realpathSync(projectRoot) 
    : projectRoot;

  const resolved = path.isAbsolute(userPath)
    ? path.resolve(userPath)
    : path.resolve(realProjectRoot, userPath);

  // Check initial resolved path
  if (!resolved.startsWith(realProjectRoot + path.sep) && resolved !== realProjectRoot) {
    throw new Error(
      `Path escape attempt blocked: "${userPath}" resolves to "${resolved}" which is outside PROJECT_ROOT "${realProjectRoot}"`
    );
  }

  // Symlink escape check: resolve actual physical path if target exists
  if (fs.existsSync(resolved)) {
    const realResolved = fs.realpathSync(resolved);
    if (!realResolved.startsWith(realProjectRoot + path.sep) && realResolved !== realProjectRoot) {
      throw new Error(
        `Symlink escape attempt blocked: "${userPath}" points to "${realResolved}" which escapes PROJECT_ROOT "${realProjectRoot}"`
      );
    }
    return realResolved;
  }

  return resolved;
}

/**
 * Check kernel-level sandbox status.
 * TODO: Implement Landlock LSM confinement wrapper on Linux environments via node-landlock bindings.
 */
export function checkKernelConfinement(): void {
  if (process.platform === 'linux') {
    console.warn(
      '⚠️ Notice: Server is running on Linux without kernel-level Landlock confinement active. Filesystem boundaries are enforced at the application level.'
    );
  }
}

export function validateCommandAllowlist(command: string): string {
  const executable = command.trim().split(/\s+/)[0];
  if (!executable) throw new Error('Empty command');
  const baseName = path.basename(executable);

  if (!config.commandAllowlist.includes(baseName)) {
    throw new Error(
      `Command not in allowlist: "${baseName}". Allowed: ${config.commandAllowlist.join(', ')}`
    );
  }

  return executable;
}

export function validateWebFetchUrl(url: string): void {
  if (config.webFetchAllowlist.length === 0) {
    throw new Error(
      'web_fetch is disabled: WEB_FETCH_ALLOWLIST is empty. Add allowed domains to .env to enable.'
    );
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(`Invalid URL: "${url}"`);
  }

  const allowed = config.webFetchAllowlist.some(domain =>
    hostname === domain || hostname.endsWith('.' + domain)
  );

  if (!allowed) {
    throw new Error(
      `Domain not in allowlist: "${hostname}". Allowed: ${config.webFetchAllowlist.join(', ')}`
    );
  }
}

// NOTE: request-level Bearer/OAuth verification lives in index.ts's
// requireAuth middleware (using verifyTokenHash from token-auth.ts), which
// also checks OAuth-issued tokens. This module previously had its own
// unused, plaintext-comparing verifyBearerToken() — removed to avoid two
// diverging implementations of the same check.
