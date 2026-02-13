import { createClient, type SupabaseClient, type RealtimeChannel } from "@supabase/supabase-js";
import type * as vscode from "vscode";
import type { AuthManager } from "../auth/auth-manager.js";
import type {
  ConversationRow,
  MessageRow,
  SupabaseConfig,
  ConversationFilter,
} from "../models/types.js";

type RealtimePayload<T> = {
  readonly new: T;
  readonly old: T | null;
  readonly eventType: "INSERT" | "UPDATE" | "DELETE";
};

export class SupabaseClientWrapper implements vscode.Disposable {
  private client: SupabaseClient | null = null;
  private realtimeChannel: RealtimeChannel | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  private onConversationChange: ((row: ConversationRow) => void) | null = null;
  private onMessageChange: ((row: MessageRow) => void) | null = null;

  constructor(private readonly authManager: AuthManager) {}

  async initialize(): Promise<void> {
    const config = await this.authManager.getSupabaseConfig();
    if (!config) {
      return;
    }
    this.createClient(config);
  }

  private createClient(config: SupabaseConfig): void {
    this.client = createClient(config.url, config.anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }

  async ensureClient(): Promise<SupabaseClient> {
    if (!this.client) {
      const config = await this.authManager.getSupabaseConfig();
      if (!config) {
        throw new Error("Supabase not configured — run 'ChatSync: Configure Supabase Connection'");
      }
      this.createClient(config);
    }
    if (!this.client) {
      throw new Error("Failed to create Supabase client");
    }

    // Set/refresh the auth session (skip if no token — anon key mode)
    const token = await this.authManager.getAccessToken();
    if (token) {
      try {
        await this.client.auth.setSession({
          access_token: token,
          refresh_token: "",
        });
      } catch {
        // setSession can fail with invalid tokens — continue with anon key
      }
    }

    return this.client;
  }

  // ── Conversations ──

  async upsertConversation(conv: ConversationRow): Promise<void> {
    const client = await this.ensureClient();
    const { error } = await client
      .from("conversations")
      .upsert(conv, { onConflict: "source_hash" });
    if (error) {
      throw new Error(`Failed to upsert conversation: ${error.message}`);
    }
  }

  async getConversations(filter?: ConversationFilter): Promise<readonly ConversationRow[]> {
    const client = await this.ensureClient();
    let query = client
      .from("conversations")
      .select("*")
      .order("updated_at", { ascending: false });

    if (filter?.sourceIde) {
      query = query.eq("source_ide", filter.sourceIde);
    }
    if (filter?.limit) {
      query = query.limit(filter.limit);
    }
    if (filter?.offset) {
      query = query.range(filter.offset, filter.offset + (filter.limit ?? 50) - 1);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to fetch conversations: ${error.message}`);
    }
    return (data ?? []) as ConversationRow[];
  }

  async getConversationByHash(sourceHash: string): Promise<ConversationRow | null> {
    const client = await this.ensureClient();
    const { data, error } = await client
      .from("conversations")
      .select("*")
      .eq("source_hash", sourceHash)
      .maybeSingle();
    if (error) {
      throw new Error(`Failed to fetch conversation: ${error.message}`);
    }
    return data as ConversationRow | null;
  }

  // ── Messages ──

  async insertMessages(messages: readonly MessageRow[]): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    const client = await this.ensureClient();
    const { error } = await client
      .from("messages")
      .upsert([...messages], { onConflict: "id" });
    if (error) {
      throw new Error(`Failed to insert messages: ${error.message}`);
    }
  }

  async getMessages(conversationId: string): Promise<readonly MessageRow[]> {
    const client = await this.ensureClient();
    const { data, error } = await client
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("timestamp", { ascending: true });
    if (error) {
      throw new Error(`Failed to fetch messages: ${error.message}`);
    }
    return (data ?? []) as MessageRow[];
  }

  // ── Full-Text Search ──

  async searchConversations(query: string): Promise<readonly ConversationRow[]> {
    const client = await this.ensureClient();
    // Search messages content, return parent conversations
    const { data, error } = await client
      .from("messages")
      .select("conversation_id, conversations!inner(*)")
      .ilike("content", `%${query}%`)
      .limit(20);
    if (error) {
      throw new Error(`Search failed: ${error.message}`);
    }

    // Deduplicate conversations
    const seen = new Set<string>();
    const conversations: ConversationRow[] = [];
    for (const row of data ?? []) {
      const conv = (row as Record<string, unknown>)["conversations"] as ConversationRow;
      if (conv && !seen.has(conv.id)) {
        seen.add(conv.id);
        conversations.push(conv);
      }
    }
    return conversations;
  }

  // ── Realtime ──

  subscribeToChanges(
    onConversation: (row: ConversationRow) => void,
    onMessage: (row: MessageRow) => void,
  ): void {
    this.onConversationChange = onConversation;
    this.onMessageChange = onMessage;
    void this.setupRealtimeChannel();
  }

  private async setupRealtimeChannel(): Promise<void> {
    if (!this.client) {
      return;
    }

    // Clean up existing channel
    if (this.realtimeChannel) {
      await this.client.removeChannel(this.realtimeChannel);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Supabase realtime type overloads are overly strict
    const channel = this.client.channel("chatsync-changes") as any;

    this.realtimeChannel = channel
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "conversations" },
        (payload: RealtimePayload<ConversationRow>) => {
          if (this.onConversationChange && payload.new) {
            this.onConversationChange(payload.new);
          }
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "messages" },
        (payload: RealtimePayload<MessageRow>) => {
          if (this.onMessageChange && payload.new) {
            this.onMessageChange(payload.new);
          }
        },
      )
      .subscribe() as RealtimeChannel;
  }

  unsubscribeFromChanges(): void {
    if (this.realtimeChannel && this.client) {
      void this.client.removeChannel(this.realtimeChannel);
      this.realtimeChannel = null;
    }
    this.onConversationChange = null;
    this.onMessageChange = null;
  }

  dispose(): void {
    this.unsubscribeFromChanges();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
