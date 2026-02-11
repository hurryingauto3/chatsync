import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BaseExtractor } from "./base-extractor.js";
import type { Conversation, Message } from "../models/types.js";

/**
 * Antigravity conversation format.
 * Conversations may be stored as JSON or Protocol Buffers (.pb).
 * For .pb files, we attempt a best-effort text extraction since the
 * protobuf schema is not publicly documented.
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

        let conv: Conversation | null = null;
        if (entry.name.endsWith(".json")) {
          conv = this.parseJsonFile(fullPath);
        } else if (entry.name.endsWith(".pb")) {
          conv = this.parseProtobufFile(fullPath);
        }

        if (conv) {
          conversations.push(conv);
        }
      }
    } catch {
      // Directory might not be readable
    }

    return conversations;
  }

  private parseJsonFile(filePath: string): Conversation | null {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(content) as AntigravityConversation;
      return this.buildConversation(data, filePath);
    } catch {
      return null;
    }
  }

  /**
   * Best-effort extraction from Protocol Buffer files.
   * Since we don't have the .proto schema, we extract readable
   * UTF-8 string segments from the binary data.
   * Protobuf stores strings as length-delimited fields (wire type 2).
   */
  private parseProtobufFile(filePath: string): Conversation | null {
    try {
      const buffer = fs.readFileSync(filePath);
      const strings = this.extractProtobufStrings(buffer);

      if (strings.length === 0) {
        return null;
      }

      // Filter to likely chat content: strings that are long enough
      // and look like natural language, not metadata
      const chatStrings = strings.filter(
        (s) => s.length > 20 && /[a-zA-Z\s]{10,}/.test(s),
      );

      if (chatStrings.length === 0) {
        return null;
      }

      const fileBaseName = path.basename(filePath, ".pb");
      const convIdInput = `antigravity:${filePath}:${fileBaseName}`;
      const convId = this.deterministicId(convIdInput);
      const messages: Message[] = [];

      // Alternate user/assistant roles for extracted strings
      for (let i = 0; i < chatStrings.length; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        messages.push({
          id: this.deterministicId(`${convIdInput}:${i}`),
          conversationId: convId,
          role: this.normalizeRole(role),
          content: chatStrings[i]!,
          sourceModel: "gemini-2.5-pro",
          timestamp: new Date().toISOString(),
          metadata: { extractedFromProtobuf: true },
        });
      }

      if (messages.length === 0) {
        return null;
      }

      return {
        id: convId,
        title: this.deriveTitle(messages),
        sourceIde: "antigravity",
        sourceHash: this.generateSourceHash("antigravity", messages),
        workspacePath: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages,
      };
    } catch {
      return null;
    }
  }

  /**
   * Extract UTF-8 strings from a protobuf binary buffer.
   * Protobuf length-delimited fields (wire type 2) store strings as:
   *   field_tag | varint_length | utf8_bytes
   * We scan for sequences that decode to valid, printable UTF-8.
   */
  private extractProtobufStrings(buffer: Buffer): string[] {
    const strings: string[] = [];
    let offset = 0;

    while (offset < buffer.length) {
      // Read tag byte
      const tag = buffer[offset]!;
      const wireType = tag & 0x07;

      // We only care about wire type 2 (length-delimited)
      if (wireType === 2) {
        offset++;
        // Read varint length
        const { value: length, bytesRead } = this.readVarint(buffer, offset);
        offset += bytesRead;

        if (length > 0 && length < 100_000 && offset + length <= buffer.length) {
          const slice = buffer.subarray(offset, offset + length);
          // Try to decode as UTF-8
          try {
            const text = slice.toString("utf-8");
            // Check if it looks like text (mostly printable chars)
            const printableRatio = text.replace(/[^\x20-\x7E\n\r\t]/g, "").length / text.length;
            if (printableRatio > 0.8 && text.length > 5) {
              strings.push(text.trim());
            }
          } catch {
            // Not valid UTF-8
          }
          offset += length;
        } else {
          offset++;
        }
      } else {
        offset++;
      }
    }

    return strings;
  }

  private readVarint(buffer: Buffer, offset: number): { value: number; bytesRead: number } {
    let value = 0;
    let shift = 0;
    let bytesRead = 0;

    while (offset < buffer.length) {
      const byte = buffer[offset]!;
      value |= (byte & 0x7f) << shift;
      bytesRead++;
      offset++;

      if ((byte & 0x80) === 0) {
        break;
      }
      shift += 7;

      // Prevent infinite loops on malformed data
      if (bytesRead > 5) {
        break;
      }
    }

    return { value, bytesRead };
  }

  private buildConversation(data: AntigravityConversation, filePath: string): Conversation | null {
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
          let conv: Conversation | null = null;
          if (filename.endsWith(".json")) {
            conv = this.parseJsonFile(fullPath);
          } else if (filename.endsWith(".pb")) {
            conv = this.parseProtobufFile(fullPath);
          }
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
