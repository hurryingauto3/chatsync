import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BaseExtractor } from "./base-extractor.js";
import { withSqliteReader } from "../utils/sqlite-reader.js";
import type { Conversation, Message } from "../models/types.js";

/**
 * Session index entry from state.vscdb key "chat.ChatSessionStore.index".
 */
interface CopilotSessionMeta {
  readonly sessionId: string;
  readonly title?: string;
  readonly lastMessageDate?: number;
  readonly isEmpty?: boolean;
}

interface SessionIndex {
  readonly version?: number;
  readonly entries?: Record<string, CopilotSessionMeta>;
}

/**
 * Prompt entry from "memento/interactive-session" -> history.copilot.
 */
interface HistoryEntry {
  readonly text?: string;
  readonly state?: unknown;
}

interface InteractiveSession {
  readonly history?: {
    readonly editor?: readonly HistoryEntry[];
    readonly copilot?: readonly HistoryEntry[];
  };
}

export class CopilotExtractor extends BaseExtractor {
  readonly sourceIde = "copilot" as const;

  private getStorageBasePaths(): string[] {
    const home = os.homedir();
    switch (process.platform) {
      case "darwin":
        return [
          path.join(home, "Library", "Application Support", "Code", "User", "workspaceStorage"),
          path.join(home, "Library", "Application Support", "VSCodium", "User", "workspaceStorage"),
        ];
      case "linux":
        return [
          path.join(home, ".config", "Code", "User", "workspaceStorage"),
          path.join(home, ".config", "VSCodium", "User", "workspaceStorage"),
        ];
      case "win32":
        return [
          path.join(home, "AppData", "Roaming", "Code", "User", "workspaceStorage"),
        ];
      default:
        return [];
    }
  }

  async isAvailable(): Promise<boolean> {
    for (const basePath of this.getStorageBasePaths()) {
      if (await this.pathExists(basePath)) {
        return true;
      }
    }
    return false;
  }

  async extractAll(): Promise<readonly Conversation[]> {
    const conversations: Conversation[] = [];

    for (const basePath of this.getStorageBasePaths()) {
      if (!(await this.pathExists(basePath))) {
        continue;
      }
      const convs = await this.extractFromStoragePath(basePath);
      conversations.push(...convs);
    }

    return conversations;
  }

  private async extractFromStoragePath(storagePath: string): Promise<Conversation[]> {
    const conversations: Conversation[] = [];

    try {
      const workspaces = fs.readdirSync(storagePath, { withFileTypes: true });

      for (const ws of workspaces) {
        if (!ws.isDirectory()) {
          continue;
        }

        const wsDir = path.join(storagePath, ws.name);
        const vscdbPath = path.join(wsDir, "state.vscdb");

        if (await this.pathExists(vscdbPath)) {
          try {
            const convs = await this.parseVscdb(vscdbPath);
            conversations.push(...convs);
          } catch {
            // Individual workspace failure shouldn't stop others
          }
        }
      }
    } catch {
      // Storage path might not be readable
    }

    return conversations;
  }

  private async parseVscdb(dbPath: string): Promise<Conversation[]> {
    return await withSqliteReader(dbPath, (reader) => {
      if (!reader.tableExists("ItemTable")) {
        return [];
      }

      // Read session index for metadata (titles, dates, session IDs)
      const indexValue = reader.getKeyValue("ItemTable", "chat.ChatSessionStore.index");
      if (!indexValue) {
        return [];
      }

      let sessionIndex: SessionIndex;
      try {
        sessionIndex = JSON.parse(indexValue) as SessionIndex;
      } catch {
        return [];
      }

      const entries = sessionIndex.entries;
      if (!entries || Object.keys(entries).length === 0) {
        return [];
      }

      // Read prompt history for the actual user message text
      const historyValue = reader.getKeyValue("ItemTable", "memento/interactive-session");
      let prompts: readonly HistoryEntry[] = [];
      if (historyValue) {
        try {
          const session = JSON.parse(historyValue) as InteractiveSession;
          prompts = session.history?.copilot ?? [];
        } catch {
          // history parsing failed, continue with session index only
        }
      }

      // Build conversations from session entries
      // Each session entry becomes a conversation with user prompts
      const conversations: Conversation[] = [];
      const sessionEntries = Object.values(entries);

      for (const meta of sessionEntries) {
        if (meta.isEmpty) {
          continue;
        }

        const convIdInput = `copilot:${dbPath}:${meta.sessionId}`;
        const convId = this.deterministicId(convIdInput);
        const messages: Message[] = [];

        // Match the session to prompts by title prefix
        const sessionTitle = meta.title ?? "";
        const matchedPrompt = prompts.find(
          (p) => p.text && sessionTitle.startsWith(p.text.slice(0, 40)),
        );

        if (matchedPrompt?.text) {
          messages.push({
            id: this.deterministicId(`${convIdInput}:user:0`),
            conversationId: convId,
            role: "user",
            content: matchedPrompt.text,
            sourceModel: null,
            timestamp: meta.lastMessageDate
              ? new Date(meta.lastMessageDate).toISOString()
              : new Date().toISOString(),
            metadata: {},
          });
        } else if (sessionTitle) {
          // Use the title as a truncated version of the user message
          messages.push({
            id: this.deterministicId(`${convIdInput}:user:0`),
            conversationId: convId,
            role: "user",
            content: sessionTitle,
            sourceModel: null,
            timestamp: meta.lastMessageDate
              ? new Date(meta.lastMessageDate).toISOString()
              : new Date().toISOString(),
            metadata: {},
          });
        }

        if (messages.length === 0) {
          continue;
        }

        const createdAt = meta.lastMessageDate
          ? new Date(meta.lastMessageDate).toISOString()
          : new Date().toISOString();

        conversations.push({
          id: convId,
          title: sessionTitle || this.deriveTitle(messages),
          sourceIde: "copilot",
          sourceHash: this.generateSourceHash("copilot", messages),
          workspacePath: this.extractWorkspaceFromPath(dbPath),
          createdAt,
          updatedAt: createdAt,
          messages,
        });
      }

      return conversations;
    });
  }

  private extractWorkspaceFromPath(dbPath: string): string | null {
    const wsDir = path.dirname(dbPath);
    const workspaceFile = path.join(wsDir, "workspace.json");
    try {
      const content = fs.readFileSync(workspaceFile, "utf-8");
      const data = JSON.parse(content) as { folder?: string };
      if (data.folder) {
        return vscode.Uri.parse(data.folder).fsPath;
      }
    } catch {
      // workspace.json might not exist
    }
    return null;
  }

  watchForChanges(cb: (conv: Conversation) => void): vscode.Disposable {
    const watchers: fs.FSWatcher[] = [];

    for (const basePath of this.getStorageBasePaths()) {
      try {
        const watcher = fs.watch(basePath, { recursive: true }, (_, filename) => {
          if (typeof filename === "string" && filename.endsWith("state.vscdb")) {
            const fullPath = path.join(basePath, filename);
            void this.parseVscdb(fullPath)
              .then((convs) => {
                for (const conv of convs) {
                  cb(conv);
                }
              })
              .catch(() => {
                // Ignore watch errors
              });
          }
        });
        watchers.push(watcher);
      } catch {
        // Path might not exist
      }
    }

    return {
      dispose: () => {
        for (const w of watchers) {
          w.close();
        }
      },
    };
  }
}
