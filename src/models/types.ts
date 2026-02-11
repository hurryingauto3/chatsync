import type * as vscode from "vscode";

// ── Source IDEs ──

export type SourceIde = "copilot" | "cursor" | "antigravity" | "claude-code";

export type MessageRole = "user" | "assistant" | "system";

// ── Core Data Models ──

export interface Message {
  readonly id: string;
  readonly conversationId: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly sourceModel: string | null;
  readonly timestamp: string;
  readonly metadata: Record<string, unknown>;
}

export interface Conversation {
  readonly id: string;
  readonly title: string;
  readonly sourceIde: SourceIde;
  readonly sourceHash: string;
  readonly workspacePath: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly messages: readonly Message[];
}

// ── Local Cache Models (extend core with sync state) ──

export interface CachedConversation extends Conversation {
  readonly userId: string;
  readonly synced: boolean;
  readonly localUpdatedAt: string;
}

export interface CachedMessage extends Message {
  readonly synced: boolean;
  readonly localUpdatedAt: string;
}

// ── Supabase Row Types (what comes from/goes to the database) ──

export interface ConversationRow {
  readonly id: string;
  readonly user_id: string;
  readonly title: string;
  readonly source_ide: SourceIde;
  readonly source_hash: string;
  readonly workspace_path: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface MessageRow {
  readonly id: string;
  readonly conversation_id: string;
  readonly role: MessageRole;
  readonly content: string;
  readonly source_model: string | null;
  readonly timestamp: string;
  readonly metadata: Record<string, unknown>;
}

// ── Extractor Interface ──

export interface ChatExtractor {
  readonly sourceIde: SourceIde;
  isAvailable(): Promise<boolean>;
  extractAll(): Promise<readonly Conversation[]>;
  watchForChanges(cb: (conv: Conversation) => void): vscode.Disposable;
}

// ── Sync Engine Types ──

export interface SyncStatus {
  readonly connected: boolean;
  readonly lastSyncedAt: string | null;
  readonly pendingUploads: number;
}

export type SyncEventType = "conversation-added" | "conversation-updated" | "message-added" | "sync-complete" | "sync-error";

export interface SyncEvent {
  readonly type: SyncEventType;
  readonly conversationId?: string;
  readonly error?: string;
}

// ── Auth Types ──

export interface AuthState {
  readonly authenticated: boolean;
  readonly userId: string | null;
  readonly githubUsername: string | null;
}

// ── Webview Message Protocol ──

export type WebviewToExtensionMessage =
  | { readonly type: "ready" }
  | { readonly type: "getConversations"; readonly filter?: ConversationFilter }
  | { readonly type: "getMessages"; readonly conversationId: string }
  | { readonly type: "search"; readonly query: string }
  | { readonly type: "continueConversation"; readonly conversationId: string }
  | { readonly type: "syncNow" }
  | { readonly type: "signIn" }
  | { readonly type: "signOut" };

export type ExtensionToWebviewMessage =
  | { readonly type: "conversations"; readonly data: readonly Conversation[] }
  | { readonly type: "messages"; readonly data: readonly Message[]; readonly conversationId: string }
  | { readonly type: "searchResults"; readonly data: readonly Conversation[]; readonly query: string }
  | { readonly type: "syncStatus"; readonly status: SyncStatus }
  | { readonly type: "authState"; readonly state: AuthState }
  | { readonly type: "error"; readonly message: string };

export interface ConversationFilter {
  readonly sourceIde?: SourceIde;
  readonly searchQuery?: string;
  readonly limit?: number;
  readonly offset?: number;
}

// ── Utility Types ──

export interface SupabaseConfig {
  readonly url: string;
  readonly anonKey: string;
}
