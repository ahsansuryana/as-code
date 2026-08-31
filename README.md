# remote-ai — Local Coding Agent MCP Server

> **Version:** 0.1.0 · **Status:** Enhanced MVP with OAuth 2.1 & Advanced Execution Harness

A production-grade Model Context Protocol (MCP) server that exposes your local workspace to web AI agents (e.g. Claude.ai) via Cloudflare Tunnel, complete with OAuth 2.1 authentication, session-based background execution, tool profile scoping, sensitive data redaction, and symlink protection.

---

## 🛠️ Tool Catalog (19 Tools)

### 1. Filesystem (Read & Inspection)
- `read_file`: Read file contents with line numbers and pagination (`offset`/`limit`).
- `list_dir`: List directory entries. Default excludes `.git`, `node_modules`, `dist`, `build`, `.venv`, etc. (override with `include_ignored: true`).
- `glob_search`: Glob search files by pattern, sorted by modification time (default excludes ignored dirs).
- `grep_search`: Regex search inside file contents (default excludes ignored dirs).

### 2. Filesystem (Write)
- `write_file`: Create or overwrite files with automatic timestamped backup (`.bak.<timestamp>`).
- `edit_file`: Targeted exact-string replacement. Enforces **read-before-edit** guard.

### 3. Execution & Background Sessions
- `exec_command`: Execute shell commands in blocking mode or background mode (`background: true` returns `session_id`).
- `run_command`: Legacy blocking command execution wrapper.
- `write_stdin`: Send interactive input to a running background session's `stdin`.
- `read_session_output`: Fetch incremental stdout/stderr output from a background session.
- `kill_session`: Force kill background execution sessions and their process groups (`SIGTERM`/`SIGKILL`).
- `list_sessions`: List active and past background sessions and their status.

### 4. Git Inspection & Operations
- `git_status`: Show short branch working tree status.
- `git_diff`: View working tree or commit diffs.
- `git_commit`: Stage files (`git add`) and commit (`git commit -m`).

### 5. Task Checklist
- `task_create`: Add multi-step work checklist items.
- `task_update`: Update status/details or delete task items.
- `task_list`: List current session task checklist.

### 6. Server Info, CWD & Permissions
- `server_info`: Retrieve active tool profile, project name, allowed commands, and capabilities.
- `get_default_cwd`: View current session default working directory.
- `set_default_cwd`: Change default working directory relative to `PROJECT_ROOT`.
- `request_permissions`: Explicit permission check gate for high-risk operations.
- `ask_user_question`: Ask clarifying multiple-choice questions.

---

## 🔒 Security Architecture

| Security Feature | Implementation Details |
|------------------|------------------------|
| **OAuth 2.1 Auth** | RFC 8414 (Discovery), RFC 9728 (Protected Resource), RFC 7591 (DCR), PKCE (`S256`). |
| **Path Confinement** | `resolveSafePath()` checks `PROJECT_ROOT` boundaries and resolves physical symlinks via `fs.realpathSync` to block symlink escape attempts. |
| **Default Ignore Filter** | `list_dir`, `glob_search`, and `grep_search` automatically filter `.git`, `node_modules`, `dist`, `build`, `.venv`, `__pycache__`, etc. |
| **Redacted Audit Log** | SQLite `audit_log` automatically masks passwords, API keys, Bearer tokens, JWTs, and long secrets in inputs and command outputs with `[REDACTED]`. |
| **Tool Profile Filtering** | `MCP_TOOL_PROFILE=read-only` completely removes destructive tools (`write_file`, `edit_file`, `exec_command`, `git_commit`, etc.) from the MCP tool registry. |
| **Process Group Kill** | `kill_session` kills full child process trees (`taskkill /F /T` on Windows, process group kill on Unix). |
| **Session Watchdog** | Background execution sessions automatically terminate after 30 minutes (`SESSION_WATCHDOG_TIMEOUT_MS`). |
| **Landlock Confinement Notice** | Logs warning on Linux when running without kernel-level Landlock LSM wrappers. |

---

## ⚙️ Environment Variables (`.env`)

```env
PORT=3000
PUBLIC_URL=https://your-tunnel-name.trycloudflare.com
BEARER_TOKEN=your-secret-32-byte-token
PROJECT_ROOT=F:/path/to/project

# Tool Profiles: full | read-only | compat-readonly-all
MCP_TOOL_PROFILE=full

# Permission Bypasses
MCP_SKIP_PERMISSIONS=false

# Watchdog timeout for background execution in ms (default 30 mins)
SESSION_WATCHDOG_TIMEOUT_MS=1800000

# Executable allowlist
COMMAND_ALLOWLIST=npm,git,node,npx,python,python3
COMMAND_TIMEOUT_CEILING_MS=600000

AUDIT_DB_PATH=./data/audit.db
BIND_ADDRESS=127.0.0.1
```

---

## 🚀 Quickstart

1. **Install dependencies & build:**
   ```bash
   npm install
   npm run build
   ```

2. **Configure `.env`:**
   ```bash
   cp .env.example .env
   ```

3. **Start MCP Server & Cloudflare Tunnel:**
   ```bash
   npm run dev
   cloudflared tunnel --url http://127.0.0.1:3000
   ```

4. **Connect from Claude.ai:**
   - Go to Claude.ai → Settings → Integrations → Add Custom Connector.
   - Enter `https://<your-tunnel>.trycloudflare.com/mcp`.
   - Complete the browser OAuth login using your `BEARER_TOKEN` password.
