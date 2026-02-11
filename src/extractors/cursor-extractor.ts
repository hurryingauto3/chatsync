import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BaseExtractor } from "./base-extractor.js";
import { withSqliteReader } from "../utils/sqlite-reader.js";
import type { Conversation, Message } from "../models/types.js";

/**
 * Composer metadata from the "composer.composerData" key.
 */
interface ComposerHead {
  readonly composerId?: string;
  readonly name?: string;
  readonly createdAt?: number;
  readonly lastUpdatedAt?: number;
  readonly unifiedMode?: string;
}

interface ComposerStore {
  readonly allComposers?: readonly ComposerHead[];
}

/**
 * Cursor aiService.prompts entry: contains full user prompt text.
 */
interface CursorPromptEntry {
  readonly text?: string;
}

/**
 * Cursor aiService.generations entry: metadata about what was generated.
 */
interface CursorGenerationEntry {
  readonly unixMs?: number;
  readonly generationUUID?: string;
  readonly type?: string;
  readonly textDescription?: string;
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
          try {
            const convs = await this.extractFromVscdb(vscdbPath);
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

  private async extractFromVscdb(dbPath: string): Promise<Conversation[]> {
    return await withSqliteReader(dbPath, (reader) => {
      if (!reader.tableExists("ItemTable")) {
        return [];
      }

      const conversations: Conversation[] = [];

      // Strategy 1: Read aiService.prompts + aiService.generations
      const promptsVal = reader.getKeyValue("ItemTable", "aiService.prompts");
      const genVal = reader.getKeyValue("ItemTable", "aiService.generations");

      if (promptsVal && genVal) {
        const convs = this.parseAiServiceData(promptsVal, genVal, dbPath);
        conversations.push(...convs);
      }

      // Strategy 2: If nothing from aiService, try composer metadata
      if (conversations.length === 0) {
        const composerVal = reader.getKeyValue("ItemTable", "composer.composerData");
        if (composerVal) {
          const convs = this.parseComposerMetadata(composerVal, dbPath);
          conversations.push(...convs);
        }
      }

      return conversations;
    });
  }

  private parseAiServiceData(
    promptsJson: string,
    generationsJson: string,
    dbPath: string,
  ): Conversation[] {
    try {
      const prompts = JSON.parse(promptsJson) as CursorPromptEntry[];
      const generations = JSON.parse(generationsJson) as CursorGenerationEntry[];

      if (!Array.isArray(prompts) || prompts.length === 0) {
        return [];
      }

      // All prompts+generations in one workspace form a single conversation stream.
      const convIdInput = `cursor:${dbPath}:aiService`;
      const convId = this.deterministicId(convIdInput);
      const messages: Message[] = [];

      for (let i = 0; i < prompts.length; i++) {
        const prompt = prompts[i];
        const gen = Array.isArray(generations) && i < generations.length ? generations[i] : undefined;

        const promptText = prompt?.text ?? "";
        const timestamp = gen?.unixMs
          ? new Date(gen.unixMs).toISOString()
          : new Date().toISOString();

        if (promptText.trim()) {
          messages.push({
            id: this.deterministicId(`${convIdInput}:user:${i}`),
            conversationId: convId,
            role: "user",
            content: promptText,
            sourceModel: null,
            timestamp,
            metadata: {},
          });
        }

        // Generations only have textDescription (short summary), not full responses.
        if (gen?.textDescription?.trim()) {
          messages.push({
            id: this.deterministicId(`${convIdInput}:assistant:${i}`),
            conversationId: convId,
            role: "assistant",
            content: `[Generated: ${gen.textDescription}]`,
            sourceModel: null,
            timestamp,
            metadata: {
              generationType: gen.type ?? "unknown",
              generationUUID: gen.generationUUID ?? "",
            },
          });
        }
      }

      if (messages.length === 0) {
        return [];
      }

      return [{
        id: convId,
        title: this.deriveTitle(messages),
        sourceIde: "cursor",
        sourceHash: this.generateSourceHash("cursor", messages),
        workspacePath: this.extractWorkspaceFromPath(dbPath),
        createdAt: messages[0]?.timestamp ?? new Date().toISOString(),
        updatedAt: messages[messages.length - 1]?.timestamp ?? new Date().toISOString(),
        messages,
      }];
    } catch {
      return [];
    }
  }

  private parseComposerMetadata(jsonValue: string, dbPath: string): Conversation[] {
    try {
      const data = JSON.parse(jsonValue) as ComposerStore;
      if (!data.allComposers) {
        return [];
      }

      const conversations: Conversation[] = [];

      for (const composer of data.allComposers) {
        if (!composer.name && !composer.composerId) {
          continue;
        }

        const convIdInput = `cursor:${dbPath}:${composer.composerId ?? "unknown"}`;
        const convId = this.deterministicId(convIdInput);
        const title = composer.name ?? "Untitled";
        const createdAt = composer.createdAt
          ? new Date(composer.createdAt).toISOString()
          : new Date().toISOString();
        const updatedAt = composer.lastUpdatedAt
          ? new Date(composer.lastUpdatedAt).toISOString()
          : createdAt;

        const messages: Message[] = [{
          id: this.deterministicId(`${convIdInput}:meta:0`),
          conversationId: convId,
          role: "user",
          content: title,
          sourceModel: null,
          timestamp: createdAt,
          metadata: { stub: true, mode: composer.unifiedMode ?? "unknown" },
        }];

        conversations.push({
          id: convId,
          title,
          sourceIde: "cursor",
          sourceHash: this.generateSourceHash("cursor", messages),
          workspacePath: this.extractWorkspaceFromPath(dbPath),
          createdAt,
          updatedAt,
          messages,
        });
      }

      return conversations;
    } catch {
      return [];
    }
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
    this.pollTimer = setInterval(() => {
      void this.pollForChanges(cb);
    }, 15_000);

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
