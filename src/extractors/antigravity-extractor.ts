import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BaseExtractor } from "./base-extractor.js";
import type { Conversation, Message } from "../models/types.js";

/**
 * Antigravity conversation format (best-effort, adapter pattern for flexibility).
 * The actual format may vary — this handles the known JSON structure.
 */
interface AntigravityMessage {
  readonly role?: string;
  readonly content?: string;
  readonly text?: string;
  readonly author?: string;
  readonly model?: string;
  readonly timestamp?: string | number;
}

interface AntigravityConversation {
  readonly id?: string;
  readonly title?: string;
  readonly messages?: readonly AntigravityMessage[];
  readonly turns?: readonly AntigravityMessage[];
  readonly created_at?: string | number;
  readonly updated_at?: string | number;
}

export class AntigravityExtractor extends BaseExtractor {
  readonly sourceIde = "antigravity" as const;
  private readonly conversationsDir: string;

  constructor() {
    super();
    this.conversationsDir = path.join(os.homedir(), ".gemini", "antigravity", "conversations");
  }

  async isAvailable(): Promise<boolean> {
    return this.pathExists(this.conversationsDir);
  }

  async extractAll(): Promise<readonly Conversation[]> {
    if (!(await this.pathExists(this.conversationsDir))) {
      return [];
    }

    const conversations: Conversation[] = [];

    try {
      const entries = fs.readdirSync(this.conversationsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile()) {
          continue;
        }

        const fullPath = path.join(this.conversationsDir, entry.name);
        const conv = this.parseConversationFile(fullPath);
        if (conv) {
          conversations.push(conv);
        }
      }
    } catch {
      // Directory might not be readable
    }

    return conversations;
  }

  private parseConversationFile(filePath: string): Conversation | null {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(content) as AntigravityConversation;

      const rawMessages = data.messages ?? data.turns ?? [];
      if (rawMessages.length === 0) {
        return null;
      }

      const convIdInput = `antigravity:${filePath}:${data.id ?? path.basename(filePath)}`;
      const convId = this.deterministicId(convIdInput);
      const messages: Message[] = [];

      for (const raw of rawMessages) {
        const text = raw.content ?? raw.text;
        if (!text?.trim()) {
          continue;
        }

        const role = this.normalizeRole(raw.role ?? raw.author ?? "user");
        const timestamp = this.parseTimestamp(raw.timestamp);

        messages.push({
          id: this.deterministicId(`${convIdInput}:${messages.length}`),
          conversationId: convId,
          role,
          content: text,
          sourceModel: raw.model ?? "gemini-2.5-pro",
          timestamp,
          metadata: {},
        });
      }

      if (messages.length === 0) {
        return null;
      }

      const createdAt = this.parseTimestamp(data.created_at) || messages[0]?.timestamp || new Date().toISOString();
      const updatedAt = this.parseTimestamp(data.updated_at) || messages[messages.length - 1]?.timestamp || createdAt;

      return {
        id: convId,
        title: data.title ?? this.deriveTitle(messages),
        sourceIde: "antigravity",
        sourceHash: this.generateSourceHash("antigravity", messages),
        workspacePath: null,
        createdAt,
        updatedAt,
        messages,
      };
    } catch {
      return null;
    }
  }

  private parseTimestamp(ts: string | number | undefined): string {
    if (!ts) {
      return new Date().toISOString();
    }
    if (typeof ts === "number") {
      return new Date(ts).toISOString();
    }
    return ts;
  }

  watchForChanges(cb: (conv: Conversation) => void): vscode.Disposable {
    let watcher: fs.FSWatcher | undefined;

    try {
      watcher = fs.watch(this.conversationsDir, (_, filename) => {
        if (typeof filename === "string") {
          const fullPath = path.join(this.conversationsDir, filename);
          const conv = this.parseConversationFile(fullPath);
          if (conv) {
            cb(conv);
          }
        }
      });
    } catch {
      // Directory might not exist yet
    }

    return {
      dispose: () => {
        watcher?.close();
      },
    };
  }
}
