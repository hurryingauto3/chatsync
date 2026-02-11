# ChatSync

Cross-IDE AI chat history sync. Extracts conversations from GitHub Copilot, Cursor, Antigravity, and Claude Code CLI, stores them in a local SQLite cache, and optionally syncs to Supabase for access across machines and IDEs.

## Problem

If you use multiple AI coding tools, you know the pain: you hit a rate limit in Cursor, switch to Copilot, and lose all context from your previous conversation. Or you work in Claude Code CLI on your laptop, then want to pick up that thread in VS Code on your desktop. Every tool silos its chat history in its own proprietary format, in its own local directory.

ChatSync reads all of them, normalizes them into a single format, and lets you browse, search, and continue any conversation from any IDE.

## How It Works

```
Local IDE chat files
  (Copilot JSON, Cursor SQLite, Claude JSONL, Antigravity JSON)
        |
        v
  Chat Extractors (per-IDE parsers)
        |
        v
  Local SQLite Cache (offline-first)
        |
        v
  Supabase (PostgreSQL + Realtime)
        |
        v
  Any other machine running ChatSync
```

1. **Extractors** read chat history files from each IDE's local storage directory.
2. Conversations are deduplicated by content hash and stored in a **local SQLite cache** (via sql.js, pure JavaScript, no native dependencies).
3. If configured, the cache syncs bidirectionally with a **Supabase** PostgreSQL database. Realtime subscriptions push changes to other connected clients within seconds.
4. A **sidebar webview** lets you browse, search, and filter all conversations. A **chat participant** (`@chatsync`) lets you inject prior conversation context directly into your current chat session.

## Supported IDEs and Tools

| Source | Format | Location |
|--------|--------|----------|
| GitHub Copilot | JSON (`workspace-chunks.json`) or SQLite (`state.vscdb`) | `~/Library/Application Support/Code/User/workspaceStorage/` |
| Cursor | SQLite (`state.vscdb`, `cursorDiskKV` table) | `~/Library/Application Support/Cursor/User/workspaceStorage/` |
| Claude Code CLI | JSONL | `~/.claude/projects/` |
| Antigravity | JSON | `~/.gemini/antigravity/conversations/` |

Paths shown are for macOS. Linux and Windows equivalents are handled automatically.

## Requirements

- VS Code `>=1.90.0`, Cursor, Antigravity, or VSCodium
- Node.js 20+ (for development)
- A Supabase project (free tier works fine) if you want cloud sync

Cloud sync is optional. The extension works fully offline with local extraction and caching.

## Installation

### From Source

```bash
git clone https://github.com/hurryingauto3/chatsync.git
cd chatsync
npm install
npm run build
```

This produces `dist/extension.js`. To install it locally:

```bash
npx @vscode/vsce package
code --install-extension chatsync-0.1.0.vsix
```

### Development

```bash
npm run watch
```

Then press `F5` in VS Code to launch the Extension Development Host.

## Supabase Setup

If you want cloud sync across machines, you need a Supabase project. If you only want local extraction and browsing, skip this section entirely.

### 1. Create the Database Schema

Go to your Supabase project dashboard, open the **SQL Editor**, and run the contents of `supabase/migrations/001_initial.sql`. This creates:

- `conversations` table with RLS policies scoped to `auth.uid()`
- `messages` table with RLS policies scoped to the owning conversation
- Indexes on user ID, update timestamp, content hash, and conversation foreign keys
- Realtime publication on both tables

### 2. Deploy the Edge Function

The `github-auth` edge function exchanges a GitHub OAuth token (obtained from VS Code's built-in authentication API) for a Supabase JWT. This avoids exposing any service role keys to the client.

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy github-auth
```

The function requires these environment variables (set automatically by Supabase):
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SUPABASE_ANON_KEY`

### 3. Configure the Extension

Run the command **ChatSync: Configure Supabase Connection** from the command palette. You will be prompted for:

1. Your Supabase project URL (e.g., `https://xxxxx.supabase.co`)
2. Your Supabase anon (public) key

Both are stored in `vscode.SecretStorage` (OS keychain). They are never written to disk, settings files, or globalState.

### 4. Sign In

Run **ChatSync: Sign In with GitHub** or click the sign-in button in the sidebar. This uses VS Code's built-in GitHub authentication provider. You will see the standard "Allow extension to use GitHub?" prompt once. The resulting GitHub token is exchanged for a Supabase JWT via the edge function. The JWT is stored in the OS keychain and auto-refreshed before expiry.

## Usage

### Sidebar

The ChatSync sidebar appears in the activity bar (chat bubble icon). It shows:

- All extracted conversations, sorted by last update
- Filter buttons for each source IDE
- A search bar for full-text search across message content
- Click any conversation to expand its full message thread
- "Continue in Chat" button to open the conversation context in your editor

### Chat Participant

Type `@chatsync` in the VS Code chat panel to use the following commands:

| Command | Description |
|---------|-------------|
| `@chatsync /recent` | Show the last 5 conversations across all IDEs |
| `@chatsync /continue [query]` | Inject the most recent (or matching) conversation as context |
| `@chatsync /search <query>` | Full-text search all synced conversations |
| `@chatsync /from <ide>` | Filter by source IDE (`copilot`, `cursor`, `antigravity`, `claude-code`) |

`/continue` formats the last 10 messages of the selected conversation into the chat response, giving the AI full context to pick up where the previous session left off.

### Commands

| Command | Description |
|---------|-------------|
| `ChatSync: Sign In with GitHub` | Authenticate via GitHub OAuth |
| `ChatSync: Sign Out` | Clear stored credentials |
| `ChatSync: Sync Now` | Trigger a full sync cycle manually |
| `ChatSync: Configure Supabase Connection` | Set Supabase URL and anon key |

### Sync Behavior

- **Extraction**: On activation and periodically, extractors scan local IDE chat files.
- **Upload**: New or updated conversations are pushed to Supabase (if authenticated).
- **Download**: Remote conversations from other machines are pulled into the local cache.
- **Realtime**: Supabase Realtime subscriptions push changes from other clients within seconds.
- **Offline**: If the network is unavailable, writes queue in the local SQLite cache and flush on reconnect.
- **Deduplication**: `source_hash` (SHA-256 of source IDE + first 3 messages) prevents duplicate imports. Enforced by a UNIQUE constraint.
- **Conflict resolution**: Last-write-wins by `updated_at`. Conversations are append-only, so conflicts are rare in practice.

## Architecture

### Project Structure

```
src/
  extension.ts              # Activation, registers all components
  auth/
    auth-manager.ts          # GitHub session -> Supabase JWT exchange
  extractors/
    base-extractor.ts        # Abstract base with hashing, dedup, role normalization
    copilot-extractor.ts     # Reads Copilot workspace-chunks.json and state.vscdb
    cursor-extractor.ts      # Reads Cursor state.vscdb (cursorDiskKV table)
    claude-code-extractor.ts # Reads Claude CLI JSONL files
    antigravity-extractor.ts # Reads Antigravity conversation JSON files
  sync/
    local-cache.ts           # SQLite cache (sql.js), mirrors Supabase schema + sync state
    supabase-client.ts       # Supabase client wrapper with CRUD and realtime
    sync-engine.ts           # Orchestrates extract -> cache -> upload -> download
  chat/
    chat-participant.ts      # @chatsync chat participant with slash commands
  webview/
    sidebar-provider.ts      # WebviewViewProvider, inline HTML with strict CSP
    ui/
      styles.css             # VS Code theme-aware styles
  models/
    types.ts                 # All TypeScript types and interfaces
  utils/
    sqlite-reader.ts         # Read-only SQLite utility (sql.js)
supabase/
  migrations/
    001_initial.sql          # Database schema, indexes, RLS policies, realtime
  functions/
    github-auth/
      index.ts               # Deno edge function for GitHub token exchange
```

### Security

- **No plaintext secrets.** All credentials (Supabase URL, anon key, JWT, refresh token) are stored in `vscode.SecretStorage`, which is backed by the OS keychain (Keychain on macOS, libsecret on Linux, Credential Manager on Windows).
- **No API keys in code.** The Supabase anon key is provided by the user once and stored encrypted.
- **Strict CSP on webviews.** `default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'`. No inline scripts, no external resources.
- **Row-Level Security.** Every Supabase query is scoped to `auth.uid()`. Users can only read and write their own data.
- **Read-only file access.** Extractors open IDE databases in read-only mode to avoid corrupting IDE state.
- **Edge Function for auth.** The GitHub-to-Supabase token exchange happens server-side. No service role keys are exposed to the client.

### TypeScript

The project uses strict TypeScript with the following compiler options enabled:

- `strict: true`
- `noImplicitAny: true`
- `strictNullChecks: true`
- `noUnusedLocals: true`
- `noUnusedParameters: true`
- `noImplicitReturns: true`

There are no `any` types in the codebase, with one annotated exception for a Supabase Realtime API type compatibility workaround.

### SSH Remote

The extension is declared as `"extensionKind": ["ui"]`, which means it always runs on the local machine, even when connected to a remote SSH workspace. This is intentional: chat history files live on the local machine, and Supabase connections go through the local network. The sidebar and chat participant work identically in remote sessions.

## Dependencies

| Package | Purpose | Size Impact |
|---------|---------|-------------|
| `@supabase/supabase-js` | Supabase client (auth, database, realtime) | Bundled |
| `sql.js` | Pure JavaScript SQLite (reads IDE databases and local cache) | Bundled |

No native dependencies. The production bundle is ~286KB minified.

## Development

```bash
# Install dependencies
npm install

# Type check
npx tsc --noEmit

# Build (production, minified)
npm run build

# Watch mode (development)
npm run watch

# Package as .vsix
npm run package
```

## License

MIT
