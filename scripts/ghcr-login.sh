#!/bin/sh
# One-shot GHCR login, run before the MCP server starts (see
# deploy/remote-ai-mcp.service ExecStartPre). Writes credentials to
# /root/.docker/config.json so subsequent `docker pull`/`push` calls
# (e.g. via the exec_command tool) are already authenticated.
set -e

if [ -n "$GIT_USER" ] && [ -n "$GIT_PAT" ]; then
  echo "[ghcr-login] Logging in to ghcr.io as $GIT_USER..."
  echo "$GIT_PAT" | docker login ghcr.io -u "$GIT_USER" --password-stdin
else
  echo "[ghcr-login] GIT_USER/GIT_PAT not set — skipping ghcr.io login."
fi
