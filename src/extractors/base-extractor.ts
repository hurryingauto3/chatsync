import * as vscode from "vscode";
import * as crypto from "node:crypto";
import type { ChatExtractor, Conversation, Message, SourceIde, MessageRole } from "../models/types.js";

export abstract class BaseExtractor implements ChatExtractor {
  abstract readonly sourceIde: SourceIde;
  abstract isAvailable(): Promise<boolean>;
  abstract extractAll(): Promise<readonly Conversation[]>;
  abstract watchForChanges(cb: (conv: Conversation) => void): vscode.Disposable;

  /**
   * Generate a deterministic source hash for deduplication.
   * Hash = SHA-256(sourceIde + first 3 messages content).
   */
  protected generateSourceHash(sourceIde: SourceIde, messages: readonly Message[]): string {
    const firstThree = messages.slice(0, 3).map((m) => m.content).join("\n");
    const input = `${sourceIde}:${firstThree}`;
    return crypto.createHash("sha256").update(input, "utf-8").digest("hex");
  }

  /**
   * Generate a stable UUID from a string (for deterministic message/conversation IDs).
   */
  protected deterministicId(input: string): string {
    const hash = crypto.createHash("sha256").update(input, "utf-8").digest("hex");
    // Format as UUID v4-like: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    return [
      hash.slice(0, 8),
      hash.slice(8, 12),
      "4" + hash.slice(13, 16),
      ((parseInt(hash.slice(16, 17), 16) & 0x3) | 0x8).toString(16) + hash.slice(17, 20),
      hash.slice(20, 32),
    ].join("-");
  }

  /**
   * Derive a conversation title from the first user message.
   */
  protected deriveTitle(messages: readonly Message[]): string {
    const firstUser = messages.find((m) => m.role === "user");
    if (!firstUser) {
      return "Untitled";
    }
    const text = firstUser.content.trim();
    if (text.length <= 80) {
      return text;
    }
    return text.slice(0, 77) + "...";
  }

  /**
   * Validate and normalize a message role string.
   */
  protected normalizeRole(role: string): MessageRole {
    const lower = role.toLowerCase();
    if (lower === "user" || lower === "human") {
      return "user";
    }
    if (lower === "assistant" || lower === "ai" || lower === "bot") {
      return "assistant";
    }
    return "system";
  }

  /**
   * Check if a file/directory exists.
   */
  protected async pathExists(filePath: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
      return true;
    } catch {
      return false;
    }
  }
}
