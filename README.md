<p align="center">
  <img src="icon.png" alt="ChatSync Logo" width="128" height="128" />
</p>

<h1 align="center">ChatSync</h1>

<p align="center">
  <strong>All your AI conversations. One place. Every IDE.</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=hurryingauto3.chatsync">
    <img src="https://img.shields.io/visual-studio-marketplace/v/hurryingauto3.chatsync?label=VS%20Code%20Marketplace&color=4F46E5&style=flat-square" alt="VS Code Marketplace" />
  </a>
  <a href="https://open-vsx.org/extension/hurryingauto3/chatsync">
    <img src="https://img.shields.io/open-vsx/v/hurryingauto3/chatsync?label=Open%20VSX&color=10B981&style=flat-square" alt="Open VSX" />
  </a>
  <a href="https://github.com/hurryingauto3/chatsync/blob/main/LICENSE.txt">
    <img src="https://img.shields.io/github/license/hurryingauto3/chatsync?style=flat-square&color=gray" alt="License" />
  </a>
</p>

---

## The Problem

You use Copilot, Cursor, Claude Code, and Antigravity — sometimes in the same hour. Each one keeps its chat history locked in its own format, in its own directory. When you switch tools, you lose all context.

**ChatSync fixes this.** It reads chat history from every AI coding tool you use, merges it into one searchable timeline, and optionally syncs it to the cloud so it follows you across machines.

## ✨ Features

- 🔍 **Unified Chat History** — Browse all your AI conversations in one sidebar, no matter which tool created them
- 🔄 **Cross-IDE Sync** — Start a conversation in Cursor, continue it in Copilot, pick it up in Claude Code
- ☁️ **Cloud Sync** — Optional Supabase backend syncs conversations across all your machines in real-time
- 💬 **Context Injection** — Use `@chatsync /continue` to inject a previous conversation into your current chat
- 🔌 **Offline First** — Works fully offline. Cloud sync is optional and additive
- 🔒 **Privacy First** — All credentials stored in your OS keychain. Read-only access to IDE files

## 🛠 Supported Tools

| Tool | Status | How It Works |
|------|--------|--------------|
| **GitHub Copilot** | ✅ Supported | Reads local JSON/SQLite chat files |
| **Cursor** | ✅ Supported | Reads SQLite database (`cursorDiskKV`) |
| **Claude Code CLI** | ✅ Supported | Reads JSONL project files |
| **Antigravity** | ✅ Supported | Reads JSON conversation files |

> Works on **macOS**, **Linux**, and **Windows**. File paths are resolved automatically per OS.

## 🚀 Quick Start

### 1. Install

**From Marketplace:**

Search for **"ChatSync"** in the VS Code / Cursor / Antigravity extension sidebar and click Install.

**From Source:**
```bash
git clone https://github.com/hurryingauto3/chatsync.git
cd chatsync
npm install
npm run build
npx @vscode/vsce package
code --install-extension chatsync-*.vsix
```

### 2. Extract Your Chats

Once installed, ChatSync automatically detects and extracts conversations from all supported tools. Open the **ChatSync** sidebar (💬 icon in the activity bar) to browse them.

That's it for local use — no account needed, no configuration required.

### 3. Enable Cloud Sync _(Optional)_

If you want your conversations to follow you across machines:

<details>
<summary><strong>☁️ Set Up Supabase (5 minutes)</strong></summary>

1. **Create a free project** at [supabase.com](https://supabase.com)

2. **Run the schema migration** — go to SQL Editor and paste:

```sql
-- Create tables
CREATE TABLE conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT 'Untitled',
  source_ide TEXT NOT NULL,
  source_hash TEXT UNIQUE,
  workspace_path TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  source_model TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

-- Indexes
CREATE INDEX idx_conv_user ON conversations(user_id);
CREATE INDEX idx_conv_updated ON conversations(updated_at DESC);
CREATE INDEX idx_conv_hash ON conversations(source_hash);
CREATE INDEX idx_msg_conv ON messages(conversation_id);

-- Disable RLS for personal use (enable + add policies for multi-user)
ALTER TABLE conversations DISABLE ROW LEVEL SECURITY;
ALTER TABLE messages DISABLE ROW LEVEL SECURITY;

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE conversations, messages;
```

3. **Configure the extension** — run these commands from the command palette (`Cmd+Shift+P`):
   - **`ChatSync: Configure Supabase Connection`** — enter your project URL and anon key
   - **`ChatSync: Sign In with GitHub`** — authenticates you

4. **Sync** — run **`ChatSync: Sync Now`** or wait for the automatic sync cycle

</details>

## 💬 Usage

### Sidebar

The ChatSync sidebar appears in the activity bar. It shows:

- All conversations across every tool, sorted by most recent
- Filter buttons to show only Copilot, Cursor, Claude, or Antigravity chats
- Full-text search across all message content
- Click any conversation to read the full thread

### Chat Participant

Type `@chatsync` in the VS Code chat panel:

| Command | What It Does |
|---------|-------------|
| `@chatsync /recent` | Shows your 5 most recent conversations across all tools |
| `@chatsync /continue [query]` | Injects a previous conversation as context into your current chat |
| `@chatsync /search <query>` | Searches all synced conversations |
| `@chatsync /from <ide>` | Filters by tool (`copilot`, `cursor`, `antigravity`, `claude-code`) |

> **Pro tip:** Use `/continue` when switching between IDEs. It feeds the AI your last conversation so you can pick up exactly where you left off.

### Commands

| Command | Description |
|---------|-------------|
| `ChatSync: Sync Now` | Trigger a full sync cycle |
| `ChatSync: Sign In with GitHub` | Authenticate for cloud sync |
| `ChatSync: Sign Out` | Clear stored credentials |
| `ChatSync: Configure Supabase Connection` | Set Supabase URL and anon key |
| `ChatSync: Toggle AI Chat Capture` | Enable/disable network-level chat interception |

## 🏗 How It Works

```
┌──────────────────────────────────────────────────────┐
│                   Your Machine                        │
│                                                       │
│  Copilot ─┐                                          │
│  Cursor  ─┤                                          │
│  Claude  ─┼──▶ Extractors ──▶ Local SQLite Cache ──┐ │
│  Antigrav ┘                                         │ │
│                                                      │ │
└──────────────────────────────────────────────────────┘ │
                                                         │
                                              ┌──────────▼──────────┐
                                              │  Supabase (cloud)   │
                                              │  PostgreSQL + RT    │
                                              └──────────┬──────────┘
                                                         │
┌──────────────────────────────────────────────────────┐ │
│               Your Other Machine                      │ │
│                                                       │ │
│  Local SQLite Cache ◀──────────────────────────────── │
│       │                                               │
│       ▼                                               │
│  Browse / Search / Continue                            │
└──────────────────────────────────────────────────────┘
```

1. **Extractors** parse chat files from each tool's local storage (read-only, never modifies IDE data)
2. **Local cache** stores everything in an in-process SQLite database (via sql.js — zero native deps)
3. **Cloud sync** pushes to Supabase with deduplication by content hash and real-time subscriptions
4. **Other machines** pull the same data and merge it into their local cache

## 🔒 Security & Privacy

- **OS Keychain storage** — all credentials (Supabase URL, keys, tokens) are stored in `vscode.SecretStorage`, backed by macOS Keychain / Linux libsecret / Windows Credential Manager
- **Read-only file access** — extractors open IDE databases in read-only mode
- **Strict CSP** — webview uses `default-src 'none'` with nonce-based script loading
- **No telemetry** — ChatSync collects zero telemetry or usage data
- **Your data stays yours** — you own the Supabase project; there's no shared backend

## 🧑‍💻 Development

```bash
# Clone and install
git clone https://github.com/hurryingauto3/chatsync.git
cd chatsync
npm install

# Development (watch mode)
npm run watch
# Then press F5 in VS Code to launch Extension Development Host

# Build for production
npm run build

# Package as .vsix
npx @vscode/vsce package

# Publish to both marketplaces
./scripts/publish.sh
```

### Project Structure

```
src/
  extension.ts              # Entry point
  auth/                     # GitHub OAuth + Supabase auth
  extractors/               # Per-IDE chat history parsers
  interceptor/              # Network-level AI chat capture
  sync/                     # SQLite cache + Supabase sync engine
  chat/                     # @chatsync chat participant
  webview/                  # Sidebar UI
  models/                   # TypeScript types
  utils/                    # Shared utilities
```

## 📦 Dependencies

Only two runtime dependencies, both bundled:

| Package | Purpose |
|---------|---------|
| `@supabase/supabase-js` | Cloud sync (auth, database, realtime) |
| `sql.js` | Pure JS SQLite for local cache + reading IDE databases |

No native modules. The production bundle is ~320KB + 644KB wasm.

## 📄 License

[MIT](LICENSE.txt) — use it however you want.
