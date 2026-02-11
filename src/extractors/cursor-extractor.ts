import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BaseExtractor } from "./base-extractor.js";
import { withSqliteReader, type SqliteReader } from "../utils/sqlite-reader.js";
import type { Conversation, Message } from "../models/types.js";

interface CursorComposerMessage {
  readonly type?: number;
  readonly text?: string;
  readonly role?: string;
  readonly createdAt?: number;
  readonly model?: string;
}

interface CursorComposerData {
  readonly composerId?: string;
  readonly name?: string;
  readonly messages?: readonly CursorComposerMessage[];
  readonly createdAt?: number;
  readonly updatedAt?: number;
}

interface CursorComposerStore {
  readonly allComposers?: readonly CursorComposerData[];
}

export class CursorExtractor extends BaseExtractor {
  readonly sourceIde = "cursor" as const;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private readonly knownMtimes = new Map<string, number>();

  private getStorageBasePath(): string {
    const home = os.homedir();
    switch (process.platform) {
      case "darwin":
        return path.join(home, "Library", "Application Support", "Cursor", "User", "workspaceStorage");
      case "linux":
        return path.join(home, ".config", "Cursor", "User", "workspaceStorage");
      case "win32":
        return path.join(home, "AppData", "Roaming", "Cursor", "User", "workspaceStorage");
      default:
        return "";
    }
  }

  async isAvailable(): Promise<boolean> {
    const basePath = this.getStorageBasePath();
    return basePath !== "" && this.pathExists(basePath);
  }

  async extractAll(): Promise<readonly Conversation[]> {
    const basePath = this.getStorageBasePath();
    if (!(await this.pathExists(basePath))) {
      return [];
    }

    const conversations: Conversation[] = [];

    try {
      const workspaces = fs.readdirSync(basePath, { withFileTypes: true });

      for (const ws of workspaces) {
        if (!ws.isDirectory()) {
          continue;
        }

        const vscdbPath = path.join(basePath, ws.name, "state.vscdb");
        if (await this.pathExists(vscdbPath)) {
          const convs = await this.extractFromVscdb(vscdbPath);
          conversations.push(...convs);
        }
      }
    } catch {
      // Storage path might not be readable
    }

    return conversations;
  }

  private async extractFromVscdb(dbPath: string): Promise<Conversation[]> {
    try {
      return await withSqliteReader(dbPath, (reader) => {
        // Cursor uses cursorDiskKV table
        if (!reader.tableExists("cursorDiskKV")) {
          // Fallback: try ItemTable (older Cursor versions)
          if (reader.tableExists("ItemTable")) {
            return this.extractFromItemTable(reader, dbPath);
          }
          return [];
        }

        // Look for composer data key
        const value = reader.getKeyValue("cursorDiskKV", "composer.composerData");
        if (!value) {
          return [];
        }

        return this.parseComposerData(value, dbPath);
      });
    } catch {
      return [];
    }
  }

  private extractFromItemTable(reader: SqliteReader, dbPath: string): Conversation[] {
    const value = reader.getKeyValue("ItemTable", "composer.composerData");
    if (!value) {
      return [];
    }
    return this.parseComposerData(value, dbPath);
  }

  private parseComposerData(jsonValue: string, dbPath: string): Conversation[] {
    try {
      const data = JSON.parse(jsonValue) as CursorComposerStore;
      if (!data.allComposers) {
        return [];
      }

      return data.allComposers
        .map((composer) => this.composerToConversation(composer, dbPath))
        .filter((c): c is Conversation => c !== null);
    } catch {
      return [];
    }
  }

  private composerToConversation(composer: CursorComposerData, dbPath: string): Conversation | null {
    if (!composer.messages || composer.messages.length === 0) {
      return null;
    }

    const convIdInput = `cursor:${dbPath}:${composer.composerId ?? "unknown"}`;
    const convId = this.deterministicId(convIdInput);
    const messages: Message[] = [];

    for (const msg of composer.messages) {
      const text = msg.text?.trim();
      if (!text) {
        continue;
      }

      const role = this.mapCursorRole(msg.type, msg.role);
      const timestamp = msg.createdAt
        ? new Date(msg.createdAt).toISOString()
        : new Date().toISOString();

      messages.push({
        id: this.deterministicId(`${convIdInput}:${messages.length}`),
        conversationId: convId,
        role,
        content: text,
        sourceModel: msg.model ?? null,
        timestamp,
        metadata: {},
      });
    }

    if (messages.length === 0) {
      return null;
    }

    const createdAt = composer.createdAt
      ? new Date(composer.createdAt).toISOString()
      : messages[0]?.timestamp ?? new Date().toISOString();

    const updatedAt = composer.updatedAt
      ? new Date(composer.updatedAt).toISOString()
      : messages[messages.length - 1]?.timestamp ?? createdAt;

    return {
      id: convId,
      title: composer.name ?? this.deriveTitle(messages),
      sourceIde: "cursor",
      sourceHash: this.generateSourceHash("cursor", messages),
      workspacePath: this.extractWorkspaceFromPath(dbPath),
      createdAt,
      updatedAt,
      messages,
    };
  }

  private mapCursorRole(type: number | undefined, role: string | undefined): "user" | "assistant" | "system" {
    // Cursor message types: 1 = user, 2 = assistant
    if (type === 1) {
      return "user";
    }
    if (type === 2) {
      return "assistant";
    }
    if (role) {
      return this.normalizeRole(role);
    }
    return "assistant";
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
    // SQLite files don't work well with fs.watch, so we poll mtime every 10s
    this.pollTimer = setInterval(() => {
      void this.pollForChanges(cb);
    }, 10_000);

    return {
      dispose: () => {
        if (this.pollTimer) {
          clearInterval(this.pollTimer);
          this.pollTimer = undefined;
        }
      },
    };
  }

  private async pollForChanges(cb: (conv: Conversation) => void): Promise<void> {
    const basePath = this.getStorageBasePath();
    if (!(await this.pathExists(basePath))) {
      return;
    }

    try {
      const workspaces = fs.readdirSync(basePath, { withFileTypes: true });

      for (const ws of workspaces) {
        if (!ws.isDirectory()) {
          continue;
        }

        const vscdbPath = path.join(basePath, ws.name, "state.vscdb");
        try {
          const stat = fs.statSync(vscdbPath);
          const lastMtime = this.knownMtimes.get(vscdbPath);
          const currentMtime = stat.mtimeMs;

          if (lastMtime !== undefined && lastMtime === currentMtime) {
            continue;
          }

          this.knownMtimes.set(vscdbPath, currentMtime);

          // Only trigger callback if we've seen this file before (skip initial scan)
          if (lastMtime !== undefined) {
            const convs = await this.extractFromVscdb(vscdbPath);
            for (const conv of convs) {
              cb(conv);
            }
          }
        } catch {
          // File might not exist
        }
      }
    } catch {
      // Directory might not be readable
    }
  }
}
