#!/usr/bin/env node

// Git invokes this executable helper when HTTPS authentication is required.
// Credentials are supplied through the parent Git process environment and are
// never placed in a Git remote URL or written to Git config.

// Keep this helper dependency-free so Git can invoke it directly.
const prompt = process.argv.slice(2).join(' ');
const isUsernamePrompt = /username/i.test(prompt);
const value = isUsernamePrompt ? process.env.GIT_USER : process.env.GIT_PAT;

if (!value) {
  process.stderr.write('Git credentials are not configured. Set GIT_USER and GIT_PAT.\n');
  process.exit(1);
}

process.stdout.write(value + '\n');
