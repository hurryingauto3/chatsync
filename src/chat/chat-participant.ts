import * as vscode from "vscode";
import type { SyncEngine } from "../sync/sync-engine.js";
import type { Conversation, SourceIde } from "../models/types.js";

export class ChatSyncParticipant implements vscode.Disposable {
  private readonly participant: vscode.ChatParticipant;

  constructor(private readonly syncEngine: SyncEngine) {
    this.participant = vscode.chat.createChatParticipant(
      "chatsync.participant",
      (request, context, stream, token) => this.handleRequest(request, context, stream, token),
    );
    this.participant.iconPath = new vscode.ThemeIcon("comment-discussion");
  }

  private async handleRequest(
    request: vscode.ChatRequest,
    _context: vscode.ChatContext,
    stream: vscode.ChatResponseStream,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const command = request.command;

    switch (command) {
      case "recent":
        await this.handleRecent(stream);
        break;
      case "continue":
        await this.handleContinue(request, stream);
        break;
      case "search":
        await this.handleSearch(request, stream);
        break;
      case "from":
        await this.handleFrom(request, stream);
        break;
      default:
        await this.handleDefault(request, stream);
        break;
    }
  }

  private async handleRecent(stream: vscode.ChatResponseStream): Promise<void> {
    const conversations = this.syncEngine.getRecentConversations(5);

    if (conversations.length === 0) {
      stream.markdown("No conversations found yet. Make sure chat extractors have run.\n");
      return;
    }

    stream.markdown("## Recent Conversations\n\n");

    for (const conv of conversations) {
      const date = new Date(conv.updatedAt).toLocaleDateString();
      const msgCount = conv.messages.length;
      stream.markdown(
        `### ${conv.title}\n` +
        `- **Source**: ${this.ideLabel(conv.sourceIde)}\n` +
        `- **Date**: ${date}\n` +
        `- **Messages**: ${msgCount}\n\n`,
      );
    }

    stream.markdown(
      "\nUse `@chatsync /continue` to pick up where you left off, " +
      "or `@chatsync /search <query>` to find a specific conversation.\n",
    );
  }

  private async handleContinue(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
  ): Promise<void> {
    // Find the conversation to continue
    let conversation: Conversation | null = null;
    const prompt = request.prompt.trim();

    if (prompt) {
      // User specified a search term — find matching conversation
      const results = this.syncEngine.searchConversations(prompt);
      if (results.length > 0 && results[0]) {
        conversation = this.syncEngine.getConversation(results[0].id);
      }
    } else {
      // Use the most recent conversation
      const recent = this.syncEngine.getRecentConversations(1);
      if (recent.length > 0 && recent[0]) {
        conversation = this.syncEngine.getConversation(recent[0].id);
      }
    }

    if (!conversation) {
      stream.markdown("No conversation found to continue. Try `@chatsync /search <query>` first.\n");
      return;
    }

    // Format the conversation history as context
    stream.markdown(
      `## Continuing: "${conversation.title}"\n` +
      `*From ${this.ideLabel(conversation.sourceIde)}*\n\n` +
      `---\n\n` +
      `**Previous conversation context:**\n\n`,
    );

    // Include last N messages for context
    const contextMessages = conversation.messages.slice(-10);
    for (const msg of contextMessages) {
      const roleIcon = msg.role === "user" ? "You" : "AI";
      const model = msg.sourceModel ? ` (${msg.sourceModel})` : "";
      stream.markdown(`**${roleIcon}${model}:**\n${msg.content}\n\n`);
    }

    stream.markdown(
      "---\n\n" +
      "The conversation above is your previous context. " +
      "You can now continue the discussion naturally. " +
      "Ask your follow-up question and the AI will have this context.\n",
    );

    // Inject as chat context using language model API if available
    await this.injectAsContext(conversation);
  }

  private async handleSearch(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
  ): Promise<void> {
    const query = request.prompt.trim();
    if (!query) {
      stream.markdown("Please provide a search query: `@chatsync /search <your query>`\n");
      return;
    }

    const results = this.syncEngine.searchConversations(query);

    if (results.length === 0) {
      stream.markdown(`No conversations found matching "${query}".\n`);
      return;
    }

    stream.markdown(`## Search Results for "${query}"\n\n`);

    for (const conv of results) {
      const date = new Date(conv.updatedAt).toLocaleDateString();
      stream.markdown(
        `### ${conv.title}\n` +
        `- **Source**: ${this.ideLabel(conv.sourceIde)}\n` +
        `- **Date**: ${date}\n` +
        `- **Messages**: ${conv.messages.length}\n\n`,
      );
    }

    stream.markdown("\nUse `@chatsync /continue <title or keyword>` to continue any of these.\n");
  }

  private async handleFrom(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
  ): Promise<void> {
    const ideInput = request.prompt.trim().toLowerCase();
    const validIdes: readonly SourceIde[] = ["copilot", "cursor", "antigravity", "claude-code"];

    const sourceIde = validIdes.find((ide) => ide === ideInput || ideInput.startsWith(ide));
    if (!sourceIde) {
      stream.markdown(
        `Unknown IDE "${ideInput}". Valid options: ${validIdes.join(", ")}\n`,
      );
      return;
    }

    const conversations = this.syncEngine.getConversations({ sourceIde, limit: 10 });

    if (conversations.length === 0) {
      stream.markdown(`No conversations found from ${this.ideLabel(sourceIde)}.\n`);
      return;
    }

    stream.markdown(`## Conversations from ${this.ideLabel(sourceIde)}\n\n`);

    for (const conv of conversations) {
      const date = new Date(conv.updatedAt).toLocaleDateString();
      stream.markdown(
        `### ${conv.title}\n` +
        `- **Date**: ${date}\n` +
        `- **Messages**: ${conv.messages.length}\n\n`,
      );
    }
  }

  private async handleDefault(
    request: vscode.ChatRequest,
    stream: vscode.ChatResponseStream,
  ): Promise<void> {
    const prompt = request.prompt.trim();

    if (!prompt) {
      stream.markdown(
        "## ChatSync Commands\n\n" +
        "- `@chatsync /recent` — Show last 5 conversations\n" +
        "- `@chatsync /continue [query]` — Continue a conversation with full context\n" +
        "- `@chatsync /search <query>` — Search all synced chats\n" +
        "- `@chatsync /from <ide>` — Filter by IDE (copilot, cursor, antigravity, claude-code)\n",
      );
      return;
    }

    // Treat unrecognized input as a search
    await this.handleSearch(request, stream);
  }

  private async injectAsContext(conversation: Conversation): Promise<void> {
    try {
      // Try to select a chat model for context injection
      const models = await vscode.lm.selectChatModels({});
      if (models.length === 0) {
        return;
      }

      // Build language model messages from conversation history
      const lmMessages: vscode.LanguageModelChatMessage[] = [];
      const contextMessages = conversation.messages.slice(-10);

      for (const msg of contextMessages) {
        if (msg.role === "user") {
          lmMessages.push(vscode.LanguageModelChatMessage.User(msg.content));
        } else if (msg.role === "assistant") {
          lmMessages.push(vscode.LanguageModelChatMessage.Assistant(msg.content));
        }
      }

      // Note: The actual context injection depends on the VS Code Chat API capabilities.
      // Currently we display the context in the response stream (above).
      // When sendChatRequest or similar API becomes available, we can inject directly.
    } catch {
      // Language model API might not be available
    }
  }

  private ideLabel(ide: SourceIde): string {
    const labels: Record<SourceIde, string> = {
      copilot: "GitHub Copilot",
      cursor: "Cursor",
      antigravity: "Antigravity",
      "claude-code": "Claude Code",
    };
    return labels[ide];
  }

  dispose(): void {
    this.participant.dispose();
  }
}
