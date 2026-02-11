import initSqlJs, { type Database as SqlJsDatabase, type SqlValue } from "sql.js";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";
import type {
  Conversation,
  Message,
  ConversationFilter,
  SourceIde,
} from "../models/types.js";

interface ConversationDbRow {
  id: string;
  user_id: string;
  title: string;
  source_ide: string;
  source_hash: string;
  workspace_path: string | null;
  created_at: string;
  updated_at: string;
  synced: number;
  local_updated_at: string;
}

interface MessageDbRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  source_model: string | null;
  timestamp: string;
  metadata: string;
  synced: number;
  local_updated_at: string;
}

export class LocalCache implements vscode.Disposable {
  private db: SqlJsDatabase | null = null;
  private readonly dbPath: string;

  constructor(storageUri: vscode.Uri) {
    this.dbPath = path.join(storageUri.fsPath, "chatsync-cache.sqlite");
  }

  async initialize(): Promise<void> {
    const SQL = await initSqlJs();

    // Load existing database or create new one
    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }

    this.createTables();
    this.persist();
  }

  private createTables(): void {
    const db = this.ensureDb();
    db.run(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT 'Untitled',
        source_ide TEXT NOT NULL,
        source_hash TEXT UNIQUE,
        workspace_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        synced INTEGER NOT NULL DEFAULT 0,
        local_updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        source_model TEXT,
        timestamp TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        synced INTEGER NOT NULL DEFAULT 0,
        local_updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    db.run("CREATE INDEX IF NOT EXISTS idx_cache_conv_hash ON conversations(source_hash)");
    db.run("CREATE INDEX IF NOT EXISTS idx_cache_conv_updated ON conversations(updated_at DESC)");
    db.run("CREATE INDEX IF NOT EXISTS idx_cache_conv_synced ON conversations(synced)");
    db.run("CREATE INDEX IF NOT EXISTS idx_cache_msg_conv ON messages(conversation_id)");
    db.run("CREATE INDEX IF NOT EXISTS idx_cache_msg_synced ON messages(synced)");
  }

  private persist(): void {
    if (!this.db) {
      return;
    }
    const data = this.db.export();
    const buffer = Buffer.from(data);
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.dbPath, buffer);
  }

  // ── Conversations ──

  upsertConversation(conv: Conversation, userId: string, synced: boolean = false): void {
    const db = this.ensureDb();
    db.run(
      `INSERT INTO conversations (id, user_id, title, source_ide, source_hash, workspace_path, created_at, updated_at, synced, local_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         updated_at = excluded.updated_at,
         synced = excluded.synced,
         local_updated_at = datetime('now')`,
      [conv.id, userId, conv.title, conv.sourceIde, conv.sourceHash, conv.workspacePath, conv.createdAt, conv.updatedAt, synced ? 1 : 0],
    );
    this.persist();
  }

  getConversation(id: string): (Conversation & { messages: Message[] }) | null {
    const rows = this.queryRows<ConversationDbRow>("SELECT * FROM conversations WHERE id = ?", [id]);
    if (rows.length === 0) {
      return null;
    }
    const messages = this.getMessages(id);
    return this.rowToConversation(rows[0]!, messages);
  }

  getConversationByHash(sourceHash: string): (Conversation & { messages: Message[] }) | null {
    const rows = this.queryRows<ConversationDbRow>("SELECT * FROM conversations WHERE source_hash = ?", [sourceHash]);
    if (rows.length === 0) {
      return null;
    }
    const row = rows[0]!;
    const messages = this.getMessages(row.id);
    return this.rowToConversation(row, messages);
  }

  getConversations(filter?: ConversationFilter): readonly Conversation[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.sourceIde) {
      conditions.push("source_ide = ?");
      params.push(filter.sourceIde);
    }

    if (filter?.searchQuery) {
      conditions.push(`id IN (
        SELECT DISTINCT conversation_id FROM messages WHERE content LIKE ?
      )`);
      params.push(`%${filter.searchQuery}%`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter?.limit ?? 50;
    const offset = filter?.offset ?? 0;

    const rows = this.queryRows<ConversationDbRow>(
      `SELECT * FROM conversations ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return rows.map((row) => {
      const messages = this.getMessages(row.id);
      return this.rowToConversation(row, messages);
    });
  }

  getUnsyncedConversations(): readonly Conversation[] {
    const rows = this.queryRows<ConversationDbRow>(
      "SELECT * FROM conversations WHERE synced = 0 ORDER BY updated_at DESC",
    );

    return rows.map((row) => {
      const messages = this.getMessages(row.id);
      return this.rowToConversation(row, messages);
    });
  }

  markConversationSynced(id: string): void {
    this.ensureDb().run("UPDATE conversations SET synced = 1 WHERE id = ?", [id]);
    this.persist();
  }

  // ── Messages ──

  upsertMessages(messages: readonly Message[], synced: boolean = false): void {
    const db = this.ensureDb();
    for (const msg of messages) {
      db.run(
        `INSERT INTO messages (id, conversation_id, role, content, source_model, timestamp, metadata, synced, local_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           content = excluded.content,
           synced = excluded.synced,
           local_updated_at = datetime('now')`,
        [
          msg.id,
          msg.conversationId,
          msg.role,
          msg.content,
          msg.sourceModel,
          msg.timestamp,
          JSON.stringify(msg.metadata),
          synced ? 1 : 0,
        ],
      );
    }
    this.persist();
  }

  getMessages(conversationId: string): Message[] {
    const rows = this.queryRows<MessageDbRow>(
      "SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC",
      [conversationId],
    );
    return rows.map((row) => this.rowToMessage(row));
  }

  getUnsyncedMessages(): readonly Message[] {
    const rows = this.queryRows<MessageDbRow>("SELECT * FROM messages WHERE synced = 0");
    return rows.map((row) => this.rowToMessage(row));
  }

  markMessagesSynced(conversationId: string): void {
    this.ensureDb().run("UPDATE messages SET synced = 1 WHERE conversation_id = ?", [conversationId]);
    this.persist();
  }

  // ── Search ──

  searchMessages(query: string, limit: number = 20): readonly Conversation[] {
    const rows = this.queryRows<ConversationDbRow>(
      `SELECT DISTINCT c.* FROM conversations c
       INNER JOIN messages m ON m.conversation_id = c.id
       WHERE m.content LIKE ?
       ORDER BY c.updated_at DESC
       LIMIT ?`,
      [`%${query}%`, limit],
    );

    return rows.map((row) => {
      const messages = this.getMessages(row.id);
      return this.rowToConversation(row, messages);
    });
  }

  // ── Query Helper ──

  private queryRows<T>(sql: string, params?: SqlValue[]): T[] {
    const db = this.ensureDb();
    const stmt = db.prepare(sql);
    if (params) {
      stmt.bind(params);
    }

    const results: T[] = [];
    while (stmt.step()) {
      const columns = stmt.getColumnNames();
      const values = stmt.get();
      const row: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i++) {
        row[columns[i]!] = values[i];
      }
      results.push(row as T);
    }
    stmt.free();
    return results;
  }

  // ── Conversion Helpers ──

  private rowToConversation(row: ConversationDbRow, messages: Message[]): Conversation & { messages: Message[] } {
    return {
      id: row.id,
      title: row.title,
      sourceIde: row.source_ide as SourceIde,
      sourceHash: row.source_hash,
      workspacePath: row.workspace_path,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messages,
    };
  }

  private rowToMessage(row: MessageDbRow): Message {
    let metadata: Record<string, unknown> = {};
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      // Invalid JSON, use empty
    }

    return {
      id: row.id,
      conversationId: row.conversation_id,
      role: row.role as "user" | "assistant" | "system",
      content: row.content,
      sourceModel: row.source_model,
      timestamp: row.timestamp,
      metadata,
    };
  }

  private ensureDb(): SqlJsDatabase {
    if (!this.db) {
      throw new Error("LocalCache not initialized. Call initialize() first.");
    }
    return this.db;
  }

  dispose(): void {
    if (this.db) {
      this.persist();
      this.db.close();
      this.db = null;
    }
  }
}
