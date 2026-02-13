import * as vscode from "vscode";
import type { AuthManager } from "../auth/auth-manager.js";
import type { SupabaseClientWrapper } from "./supabase-client.js";
import type { LocalCache } from "./local-cache.js";
import type {
  ChatExtractor,
  Conversation,
  ConversationRow,
  MessageRow,
  SyncStatus,
  SyncEvent,
  ConversationFilter,
} from "../models/types.js";

export class SyncEngine implements vscode.Disposable {
  private readonly _onSyncEvent = new vscode.EventEmitter<SyncEvent>();
  public readonly onSyncEvent = this._onSyncEvent.event;

  private readonly extractorDisposables: vscode.Disposable[] = [];
  private syncInProgress = false;
  private lastSyncedAt: string | null = null;
  private readonly log: vscode.OutputChannel;

  constructor(
    private readonly authManager: AuthManager,
    private readonly supabase: SupabaseClientWrapper,
    private readonly cache: LocalCache,
    private readonly extractors: readonly ChatExtractor[],
  ) {
    this.log = vscode.window.createOutputChannel("ChatSync");

    // Auto-sync when authentication state changes
    this.authManager.onAuthStateChanged((state) => {
      if (state.authenticated) {
        this.log.appendLine("[sync] Auth detected, starting background sync...");
        void this.fullSync();
      }
    });
  }

  async initialize(): Promise<void> {
    // Start watching all available extractors
    for (const extractor of this.extractors) {
      const available = await extractor.isAvailable();
      if (!available) {
        continue;
      }

      const disposable = extractor.watchForChanges((conv) => {
        void this.handleExtractedConversation(conv);
      });
      this.extractorDisposables.push(disposable);
    }

    // Subscribe to realtime changes from Supabase
    this.supabase.subscribeToChanges(
      (convRow) => this.handleRemoteConversationChange(convRow),
      (msgRow) => this.handleRemoteMessageChange(msgRow),
    );

    // Do initial sync
    await this.fullSync();
  }

  async fullSync(): Promise<void> {
    if (this.syncInProgress) {
      this.log.appendLine("[sync] Sync already in progress, skipping");
      return;
    }
    this.syncInProgress = true;
    this.log.appendLine("[sync] ═══ Full Sync Started ═══");

    try {
      // Phase 1: Extract from all local IDEs
      this.log.appendLine("[sync] Phase 1: Extracting from local sources...");
      await this.extractFromAllSources();

      const totalLocal = this.cache.getConversations({}).length;
      this.log.appendLine(`[sync] Local cache has ${totalLocal} conversations total`);

      // Phase 2: Upload unsynced local data to Supabase
      if (this.authManager.authState.authenticated) {
        this.log.appendLine(`[sync] Phase 2: Uploading unsynced... (userId=${this.authManager.authState.userId})`);
        const unsynced = this.cache.getUnsyncedConversations();
        this.log.appendLine(`[sync]   ${unsynced.length} conversations pending upload`);
        await this.uploadUnsynced();
      } else {
        this.log.appendLine("[sync] Phase 2: SKIPPED — not authenticated");
      }

      // Phase 3: Download remote conversations
      if (this.authManager.authState.authenticated) {
        this.log.appendLine("[sync] Phase 3: Downloading remote conversations...");
        await this.downloadRemote();
      } else {
        this.log.appendLine("[sync] Phase 3: SKIPPED — not authenticated");
      }

      this.lastSyncedAt = new Date().toISOString();
      this._onSyncEvent.fire({ type: "sync-complete" });
      this.log.appendLine("[sync] ═══ Full Sync Complete ═══");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown sync error";
      this.log.appendLine(`[sync] ═══ Full Sync FAILED: ${message} ═══`);
      this._onSyncEvent.fire({ type: "sync-error", error: message });
    } finally {
      this.syncInProgress = false;
    }
  }

  // ── Local Queries (from cache) ──

  getConversations(filter?: ConversationFilter): readonly Conversation[] {
    return this.cache.getConversations(filter);
  }

  getConversation(id: string): Conversation | null {
    return this.cache.getConversation(id);
  }

  searchConversations(query: string): readonly Conversation[] {
    return this.cache.searchMessages(query);
  }

  getRecentConversations(limit: number = 5): readonly Conversation[] {
    return this.cache.getConversations({ limit });
  }

  getSyncStatus(): SyncStatus {
    const unsynced = this.cache.getUnsyncedConversations();
    return {
      connected: this.authManager.authState.authenticated,
      lastSyncedAt: this.lastSyncedAt,
      pendingUploads: unsynced.length,
    };
  }

  // ── Extraction ──

  private async extractFromAllSources(): Promise<void> {
    const userId = this.authManager.authState.userId ?? "";
    this.log.appendLine(`[sync] Starting extraction, ${this.extractors.length} extractors registered`);

    for (const extractor of this.extractors) {
      const ide = extractor.sourceIde;
      try {
        const available = await extractor.isAvailable();
        if (!available) {
          this.log.appendLine(`[${ide}] Not available, skipping`);
          continue;
        }

        this.log.appendLine(`[${ide}] Available, extracting...`);
        const conversations = await extractor.extractAll();
        this.log.appendLine(`[${ide}] Found ${conversations.length} conversations`);

        for (const conv of conversations) {
          this.log.appendLine(`[${ide}]   "${conv.title.slice(0, 60)}" (${conv.messages.length} msgs)`);
          this.storeConversationLocally(conv, userId);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.appendLine(`[${ide}] ERROR: ${msg}`);
      }
    }
  }

  public handleExtractedConversation(conv: Conversation): void {
    const userId = this.authManager.authState.userId ?? "";
    this.storeConversationLocally(conv, userId);

    // Upload if authenticated
    if (this.authManager.authState.authenticated) {
      void this.uploadConversation(conv, userId);
    }

    this._onSyncEvent.fire({
      type: "conversation-added",
      conversationId: conv.id,
    });
  }

  private storeConversationLocally(conv: Conversation, userId: string): void {
    // Check if we already have this conversation (by hash)
    const existing = this.cache.getConversationByHash(conv.sourceHash);
    if (existing) {
      // Update if the new version has more messages
      if (conv.messages.length > existing.messages.length) {
        this.cache.upsertConversation(conv, userId, false);
        this.cache.upsertMessages(conv.messages, false);
      }
      return;
    }

    this.cache.upsertConversation(conv, userId, false);
    this.cache.upsertMessages(conv.messages, false);
  }

  // ── Upload ──

  private async uploadUnsynced(): Promise<void> {
    const unsynced = this.cache.getUnsyncedConversations();
    const userId = this.authManager.authState.userId;
    if (!userId) {
      return;
    }

    for (const conv of unsynced) {
      try {
        await this.uploadConversation(conv, userId);
      } catch (err) {
        this.log.appendLine(`[sync] Failed to upload conversation ${conv.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private async uploadConversation(conv: Conversation, userId: string): Promise<void> {
    try {
      // Check if already exists remotely by hash
      const existing = await this.supabase.getConversationByHash(conv.sourceHash);
      if (existing) {
        // Update existing remote conversation with new messages
        const remoteMessages = await this.supabase.getMessages(existing.id);
        const newMessages = conv.messages.filter(
          (m) => !remoteMessages.some((rm) => rm.id === m.id),
        );
        if (newMessages.length > 0) {
          const messageRows: MessageRow[] = newMessages.map((m) => ({
            id: m.id,
            conversation_id: existing.id,
            role: m.role,
            content: m.content,
            source_model: m.sourceModel,
            timestamp: m.timestamp,
            metadata: m.metadata,
          }));
          await this.supabase.insertMessages(messageRows);
        }
      } else {
        // Create new remote conversation
        const convRow: ConversationRow = {
          id: conv.id,
          user_id: userId,
          title: conv.title,
          source_ide: conv.sourceIde,
          source_hash: conv.sourceHash,
          workspace_path: conv.workspacePath,
          created_at: conv.createdAt,
          updated_at: conv.updatedAt,
        };
        await this.supabase.upsertConversation(convRow);

        const messageRows: MessageRow[] = conv.messages.map((m) => ({
          id: m.id,
          conversation_id: conv.id,
          role: m.role,
          content: m.content,
          source_model: m.sourceModel,
          timestamp: m.timestamp,
          metadata: m.metadata,
        }));
        await this.supabase.insertMessages(messageRows);
        this.log.appendLine(`[sync] Created new remote conversation: ${conv.title}`);
      }


      this.cache.markConversationSynced(conv.id);
      this.cache.markMessagesSynced(conv.id);
    } catch (err) {
      this.log.appendLine(`[sync] ERR: Upload failed for "${conv.title}": ${err instanceof Error ? err.message : String(err)}`);
      throw err; // Re-throw to be caught by fullSync()
    }
  }

  // ── Download ──

  private async downloadRemote(): Promise<void> {
    try {
      const remoteConversations = await this.supabase.getConversations({ limit: 100 });
      const userId = this.authManager.authState.userId ?? "";

      for (const convRow of remoteConversations) {
        // Check if we already have this locally
        const localConv = this.cache.getConversation(convRow.id);
        if (localConv) {
          continue;
        }

        // Download messages for this conversation
        const messageRows = await this.supabase.getMessages(convRow.id);
        const messages = messageRows.map((mr): import("../models/types.js").Message => ({
          id: mr.id,
          conversationId: mr.conversation_id,
          role: mr.role as "user" | "assistant" | "system",
          content: mr.content,
          sourceModel: mr.source_model,
          timestamp: mr.timestamp,
          metadata: mr.metadata,
        }));

        const conv: Conversation = {
          id: convRow.id,
          title: convRow.title,
          sourceIde: convRow.source_ide,
          sourceHash: convRow.source_hash,
          workspacePath: convRow.workspace_path,
          createdAt: convRow.created_at,
          updatedAt: convRow.updated_at,
          messages,
        };

        this.cache.upsertConversation(conv, userId, true);
        this.cache.upsertMessages(messages, true);

        this._onSyncEvent.fire({
          type: "conversation-added",
          conversationId: conv.id,
        });
      }
    } catch {
      // Download failed — local cache still works offline
    }
  }

  // ── Realtime Handlers ──

  private handleRemoteConversationChange(convRow: ConversationRow): void {
    const userId = this.authManager.authState.userId ?? "";

    // Don't re-import our own uploads
    if (convRow.user_id !== userId) {
      return;
    }

    const conv: Conversation = {
      id: convRow.id,
      title: convRow.title,
      sourceIde: convRow.source_ide,
      sourceHash: convRow.source_hash,
      workspacePath: convRow.workspace_path,
      createdAt: convRow.created_at,
      updatedAt: convRow.updated_at,
      messages: [],
    };

    this.cache.upsertConversation(conv, userId, true);
    this._onSyncEvent.fire({
      type: "conversation-updated",
      conversationId: conv.id,
    });
  }

  private handleRemoteMessageChange(msgRow: MessageRow): void {
    const message: import("../models/types.js").Message = {
      id: msgRow.id,
      conversationId: msgRow.conversation_id,
      role: msgRow.role as "user" | "assistant" | "system",
      content: msgRow.content,
      sourceModel: msgRow.source_model,
      timestamp: msgRow.timestamp,
      metadata: msgRow.metadata,
    };

    this.cache.upsertMessages([message], true);
    this._onSyncEvent.fire({
      type: "message-added",
      conversationId: msgRow.conversation_id,
    });
  }

  dispose(): void {
    this._onSyncEvent.dispose();
    this.supabase.unsubscribeFromChanges();
    for (const d of this.extractorDisposables) {
      d.dispose();
    }
  }
}
