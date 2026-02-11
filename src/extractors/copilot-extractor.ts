import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BaseExtractor } from "./base-extractor.js";
import { withSqliteReader } from "../utils/sqlite-reader.js";
import type { Conversation, Message } from "../models/types.js";

interface CopilotChatTurn {
  readonly request?: string;
  readonly response?: string;
  readonly agent?: string;
  readonly timestamp?: number;
}

interface CopilotSession {
  readonly sessionId?: string;
  readonly requester?: { readonly id?: string };
  readonly turns?: readonly CopilotChatTurn[];
  readonly creationDate?: number;
}

interface WorkspaceChunks {
  readonly sessions?: readonly CopilotSession[];
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

        // Try workspace-chunks.json first (newer Copilot)
        const chunksPath = path.join(wsDir, "GitHub.copilot-chat", "workspace-chunks.json");
        if (await this.pathExists(chunksPath)) {
          const convs = this.parseWorkspaceChunks(chunksPath);
          conversations.push(...convs);
          continue;
        }

        // Fallback: try state.vscdb SQLite
        const vscdbPath = path.join(wsDir, "state.vscdb");
        if (await this.pathExists(vscdbPath)) {
          const convs = await this.parseVscdb(vscdbPath);
          conversations.push(...convs);
        }
      }
    } catch {
      // Storage path might not be readable
    }

    return conversations;
  }

  private parseWorkspaceChunks(filePath: string): Conversation[] {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(content) as WorkspaceChunks;

      if (!data.sessions) {
        return [];
      }

      return data.sessions
        .map((session) => this.sessionToConversation(session, filePath))
        .filter((c): c is Conversation => c !== null);
    } catch {
      return [];
    }
  }

  private async parseVscdb(dbPath: string): Promise<Conversation[]> {
    try {
      return await withSqliteReader(dbPath, (reader) => {
        if (!reader.tableExists("ItemTable")) {
          return [];
        }

        // Look for Copilot chat sessions in the memento store
        const value = reader.getKeyValue("ItemTable", "memento/interactive-session");
        if (!value) {
          return [];
        }

        const data = JSON.parse(value) as WorkspaceChunks;
        if (!data.sessions) {
          return [];
        }

        return data.sessions
          .map((session) => this.sessionToConversation(session, dbPath))
          .filter((c): c is Conversation => c !== null);
      });
    } catch {
      return [];
    }
  }

  private sessionToConversation(session: CopilotSession, sourcePath: string): Conversation | null {
    if (!session.turns || session.turns.length === 0) {
      return null;
    }

    const messages: Message[] = [];
    const convIdInput = `copilot:${sourcePath}:${session.sessionId ?? "unknown"}`;
    const convId = this.deterministicId(convIdInput);

    for (const turn of session.turns) {
      const timestamp = turn.timestamp
        ? new Date(turn.timestamp).toISOString()
        : new Date().toISOString();

      if (turn.request) {
        messages.push({
          id: this.deterministicId(`${convIdInput}:user:${messages.length}`),
          conversationId: convId,
          role: "user",
          content: turn.request,
          sourceModel: null,
          timestamp,
          metadata: turn.agent ? { agent: turn.agent } : {},
        });
      }

      if (turn.response) {
        messages.push({
          id: this.deterministicId(`${convIdInput}:assistant:${messages.length}`),
          conversationId: convId,
          role: "assistant",
          content: turn.response,
          sourceModel: "gpt-4o",
          timestamp,
          metadata: {},
        });
      }
    }

    if (messages.length === 0) {
      return null;
    }

    const createdAt = session.creationDate
      ? new Date(session.creationDate).toISOString()
      : messages[0]?.timestamp ?? new Date().toISOString();

    return {
      id: convId,
      title: this.deriveTitle(messages),
      sourceIde: "copilot",
      sourceHash: this.generateSourceHash("copilot", messages),
      workspacePath: this.extractWorkspaceFromPath(sourcePath),
      createdAt,
      updatedAt: messages[messages.length - 1]?.timestamp ?? createdAt,
      messages,
    };
  }

  private extractWorkspaceFromPath(filePath: string): string | null {
    // Try to read workspace.json in the same workspace storage dir
    const wsDir = path.dirname(
      filePath.includes("GitHub.copilot-chat") ? path.dirname(filePath) : filePath,
    );
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
          if (
            typeof filename === "string" &&
            (filename.endsWith("workspace-chunks.json") || filename.endsWith("state.vscdb"))
          ) {
            const fullPath = path.join(basePath, filename);
            if (filename.endsWith("workspace-chunks.json")) {
              for (const conv of this.parseWorkspaceChunks(fullPath)) {
                cb(conv);
              }
            }
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
