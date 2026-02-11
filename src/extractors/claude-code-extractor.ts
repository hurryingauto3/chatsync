import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BaseExtractor } from "./base-extractor.js";
import type { Conversation, Message } from "../models/types.js";

interface ClaudeJsonlEntry {
  readonly type: string;
  readonly sessionId?: string;
  readonly message?: {
    readonly role: string;
    readonly content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>;
    readonly model?: string;
  };
  readonly timestamp?: string;
}

export class ClaudeCodeExtractor extends BaseExtractor {
  readonly sourceIde = "claude-code" as const;
  private readonly claudeDir: string;

  constructor() {
    super();
    this.claudeDir = path.join(os.homedir(), ".claude");
  }

  async isAvailable(): Promise<boolean> {
    return this.pathExists(this.claudeDir);
  }

  async extractAll(): Promise<readonly Conversation[]> {
    const conversations: Conversation[] = [];

    // Read from ~/.claude/projects/*/*.jsonl
    const projectsDir = path.join(this.claudeDir, "projects");
    if (await this.pathExists(projectsDir)) {
      const projectConvs = await this.extractFromDirectory(projectsDir);
      conversations.push(...projectConvs);
    }

    return conversations;
  }

  private async extractFromDirectory(dir: string): Promise<Conversation[]> {
    const conversations: Conversation[] = [];

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // Recurse into subdirectories
          const subConvs = await this.extractFromDirectory(fullPath);
          conversations.push(...subConvs);
        } else if (entry.name.endsWith(".jsonl")) {
          const conv = await this.parseJsonlFile(fullPath);
          if (conv) {
            conversations.push(conv);
          }
        }
      }
    } catch {
      // Directory might not exist or be unreadable
    }

    return conversations;
  }

  private async parseJsonlFile(filePath: string): Promise<Conversation | null> {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter((line) => line.trim().length > 0);

      const messages: Message[] = [];
      let sessionId = "";
      let firstTimestamp = "";

      for (const line of lines) {
        let entry: ClaudeJsonlEntry;
        try {
          entry = JSON.parse(line) as ClaudeJsonlEntry;
        } catch {
          continue;
        }

        if (entry.sessionId && !sessionId) {
          sessionId = entry.sessionId;
        }

        if (!entry.message?.role || !entry.message?.content) {
          continue;
        }

        const timestamp = entry.timestamp ?? new Date().toISOString();
        if (!firstTimestamp) {
          firstTimestamp = timestamp;
        }

        // Content can be string or array of content blocks
        let textContent: string;
        if (typeof entry.message.content === "string") {
          textContent = entry.message.content;
        } else {
          textContent = entry.message.content
            .filter((block) => block.type === "text" && block.text)
            .map((block) => block.text ?? "")
            .join("\n");
        }

        if (!textContent.trim()) {
          continue;
        }

        const msgId = this.deterministicId(`claude-code:${filePath}:${messages.length}`);
        messages.push({
          id: msgId,
          conversationId: "", // Will be set below
          role: this.normalizeRole(entry.message.role),
          content: textContent,
          sourceModel: entry.message.model ?? null,
          timestamp,
          metadata: {},
        });
      }

      if (messages.length === 0) {
        return null;
      }

      const sourceHash = this.generateSourceHash("claude-code", messages);
      const convId = this.deterministicId(`claude-code:${filePath}`);
      const title = this.deriveTitle(messages);

      // Determine workspace path from file path
      const workspacePath = this.extractWorkspacePath(filePath);

      const messagesWithConvId = messages.map((m) => ({
        ...m,
        conversationId: convId,
      }));

      return {
        id: convId,
        title,
        sourceIde: "claude-code",
        sourceHash,
        workspacePath,
        createdAt: firstTimestamp || new Date().toISOString(),
        updatedAt: messages[messages.length - 1]?.timestamp ?? new Date().toISOString(),
        messages: messagesWithConvId,
      };
    } catch {
      return null;
    }
  }

  private extractWorkspacePath(filePath: string): string | null {
    // ~/.claude/projects/<encoded-path>/session.jsonl
    const projectsDir = path.join(this.claudeDir, "projects");
    if (filePath.startsWith(projectsDir)) {
      const relative = filePath.slice(projectsDir.length + 1);
      const parts = relative.split(path.sep);
      if (parts[0]) {
        // Decode the project directory name (usually URL-encoded path)
        return decodeURIComponent(parts[0]).replace(/-/g, "/");
      }
    }
    return null;
  }

  watchForChanges(cb: (conv: Conversation) => void): vscode.Disposable {
    const projectsDir = path.join(this.claudeDir, "projects");

    let watcher: fs.FSWatcher | undefined;
    try {
      watcher = fs.watch(projectsDir, { recursive: true }, (eventType, filename) => {
        if (typeof filename === "string" && filename.endsWith(".jsonl")) {
          const fullPath = path.join(projectsDir, filename);
          void this.parseJsonlFile(fullPath).then((conv) => {
            if (conv) {
              cb(conv);
            }
          });
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
