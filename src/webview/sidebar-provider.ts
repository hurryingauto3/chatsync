import * as vscode from "vscode";
import * as crypto from "node:crypto";
import type { SyncEngine } from "../sync/sync-engine.js";
import type { AuthManager } from "../auth/auth-manager.js";
import type {
  WebviewToExtensionMessage,
  ExtensionToWebviewMessage,
  Conversation,
  ConversationFilter,
} from "../models/types.js";

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "chatsync.sidebarView";

  private webviewView: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly syncEngine: SyncEngine,
    private readonly authManager: AuthManager,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.webviewView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(
      (message: WebviewToExtensionMessage) => {
        void this.handleWebviewMessage(message);
      },
    );

    // Listen for sync events
    this.syncEngine.onSyncEvent(() => {
      this.sendSyncStatus();
    });

    // Listen for auth changes
    this.authManager.onAuthStateChanged((state) => {
      this.postMessage({ type: "authState", state });
    });
  }

  private async handleWebviewMessage(message: WebviewToExtensionMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        this.sendSyncStatus();
        this.postMessage({
          type: "authState",
          state: this.authManager.authState,
        });
        this.sendConversations();
        break;

      case "getConversations":
        this.sendConversations(message.filter);
        break;

      case "getMessages": {
        const conv = this.syncEngine.getConversation(message.conversationId);
        if (conv) {
          this.postMessage({
            type: "messages",
            data: conv.messages,
            conversationId: message.conversationId,
          });
        }
        break;
      }

      case "search": {
        const results = this.syncEngine.searchConversations(message.query);
        this.postMessage({
          type: "searchResults",
          data: results,
          query: message.query,
        });
        break;
      }

      case "continueConversation": {
        const conv = this.syncEngine.getConversation(message.conversationId);
        if (conv) {
          await this.continueInChat(conv);
        }
        break;
      }

      case "syncNow":
        await this.syncEngine.fullSync();
        break;

      case "signIn":
        try {
          await this.authManager.signIn();
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : "Sign in failed";
          this.postMessage({ type: "error", message: errorMsg });
        }
        break;

      case "signOut":
        await this.authManager.signOut();
        break;
    }
  }

  private sendConversations(filter?: ConversationFilter): void {
    const conversations = this.syncEngine.getConversations(filter);
    this.postMessage({ type: "conversations", data: conversations });
  }

  private sendSyncStatus(): void {
    this.postMessage({
      type: "syncStatus",
      status: this.syncEngine.getSyncStatus(),
    });
  }

  private async continueInChat(conv: Conversation): Promise<void> {
    // Format conversation as context and open in editor/chat
    const contextLines = [
      `# Continuing conversation from ${conv.sourceIde}`,
      `## "${conv.title}"`,
      "",
    ];

    for (const msg of conv.messages.slice(-10)) {
      contextLines.push(`**${msg.role}**: ${msg.content}`);
      contextLines.push("");
    }

    const doc = await vscode.workspace.openTextDocument({
      content: contextLines.join("\n"),
      language: "markdown",
    });
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  private postMessage(message: ExtensionToWebviewMessage): void {
    this.webviewView?.webview.postMessage(message);
  }

  private getHtmlContent(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("hex");

    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "src", "webview", "ui", "styles.css"),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${styleUri}">
  <title>ChatSync</title>
</head>
<body>
  <div id="app">
    <div id="auth-section" class="section hidden">
      <p>Sign in to sync chats across IDEs</p>
      <button id="sign-in-btn" class="primary-btn">Sign in with GitHub</button>
    </div>

    <div id="main-section" class="section hidden">
      <div class="toolbar">
        <input type="text" id="search-input" placeholder="Search conversations..." />
        <div class="filter-bar">
          <button class="filter-btn active" data-filter="all">All</button>
          <button class="filter-btn" data-filter="copilot">Copilot</button>
          <button class="filter-btn" data-filter="cursor">Cursor</button>
          <button class="filter-btn" data-filter="antigravity">Antigravity</button>
          <button class="filter-btn" data-filter="claude-code">Claude</button>
        </div>
      </div>

      <div id="sync-status" class="status-bar"></div>

      <div id="conversations-list" class="conversations-list"></div>

      <div id="conversation-detail" class="conversation-detail hidden">
        <button id="back-btn" class="back-btn">&larr; Back</button>
        <div id="detail-title" class="detail-title"></div>
        <div id="messages-list" class="messages-list"></div>
        <button id="continue-btn" class="primary-btn">Continue in Chat</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // State
    let currentFilter = 'all';
    let currentConversationId = null;

    // Elements
    const authSection = document.getElementById('auth-section');
    const mainSection = document.getElementById('main-section');
    const signInBtn = document.getElementById('sign-in-btn');
    const searchInput = document.getElementById('search-input');
    const convList = document.getElementById('conversations-list');
    const detailView = document.getElementById('conversation-detail');
    const detailTitle = document.getElementById('detail-title');
    const messagesList = document.getElementById('messages-list');
    const backBtn = document.getElementById('back-btn');
    const continueBtn = document.getElementById('continue-btn');
    const syncStatus = document.getElementById('sync-status');
    const filterBtns = document.querySelectorAll('.filter-btn');

    // Event listeners
    signInBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'signIn' });
    });

    searchInput.addEventListener('input', debounce((e) => {
      const query = e.target.value.trim();
      if (query.length > 0) {
        vscode.postMessage({ type: 'search', query });
      } else {
        vscode.postMessage({ type: 'getConversations', filter: getFilter() });
      }
    }, 300));

    filterBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        vscode.postMessage({ type: 'getConversations', filter: getFilter() });
      });
    });

    backBtn.addEventListener('click', () => {
      detailView.classList.add('hidden');
      convList.classList.remove('hidden');
      document.querySelector('.toolbar').classList.remove('hidden');
      currentConversationId = null;
    });

    continueBtn.addEventListener('click', () => {
      if (currentConversationId) {
        vscode.postMessage({ type: 'continueConversation', conversationId: currentConversationId });
      }
    });

    // Message handler
    window.addEventListener('message', (event) => {
      const message = event.data;
      switch (message.type) {
        case 'authState':
          if (message.state.authenticated) {
            authSection.classList.add('hidden');
            mainSection.classList.remove('hidden');
          } else {
            authSection.classList.remove('hidden');
            mainSection.classList.add('hidden');
          }
          break;

        case 'conversations':
        case 'searchResults':
          renderConversations(message.data);
          break;

        case 'messages':
          renderMessages(message.data, message.conversationId);
          break;

        case 'syncStatus':
          renderSyncStatus(message.status);
          break;

        case 'error':
          renderError(message.message);
          break;
      }
    });

    // Renderers
    function renderConversations(conversations) {
      convList.innerHTML = '';
      if (conversations.length === 0) {
        convList.innerHTML = '<div class="empty">No conversations found</div>';
        return;
      }
      conversations.forEach(conv => {
        const el = document.createElement('div');
        el.className = 'conv-item';
        const date = new Date(conv.updatedAt).toLocaleDateString();
        const msgCount = conv.messages ? conv.messages.length : 0;
        el.innerHTML =
          '<div class="conv-header">' +
            '<span class="conv-badge badge-' + escapeHtml(conv.sourceIde) + '">' + escapeHtml(conv.sourceIde) + '</span>' +
            '<span class="conv-date">' + escapeHtml(date) + '</span>' +
          '</div>' +
          '<div class="conv-title">' + escapeHtml(conv.title) + '</div>' +
          '<div class="conv-meta">' + msgCount + ' messages</div>';
        el.addEventListener('click', () => {
          currentConversationId = conv.id;
          vscode.postMessage({ type: 'getMessages', conversationId: conv.id });
          convList.classList.add('hidden');
          document.querySelector('.toolbar').classList.add('hidden');
          detailView.classList.remove('hidden');
          detailTitle.textContent = conv.title;
        });
        convList.appendChild(el);
      });
    }

    function renderMessages(messages) {
      messagesList.innerHTML = '';
      messages.forEach(msg => {
        const el = document.createElement('div');
        el.className = 'msg-item msg-' + msg.role;
        el.innerHTML =
          '<div class="msg-role">' + escapeHtml(msg.role) + (msg.sourceModel ? ' (' + escapeHtml(msg.sourceModel) + ')' : '') + '</div>' +
          '<div class="msg-content">' + escapeHtml(msg.content) + '</div>';
        messagesList.appendChild(el);
      });
    }

    function renderSyncStatus(status) {
      const parts = [];
      if (status.connected) {
        parts.push('Connected');
      } else {
        parts.push('Offline');
      }
      if (status.pendingUploads > 0) {
        parts.push(status.pendingUploads + ' pending');
      }
      if (status.lastSyncedAt) {
        parts.push('Last sync: ' + new Date(status.lastSyncedAt).toLocaleTimeString());
      }
      syncStatus.textContent = parts.join(' | ');
    }

    function renderError(message) {
      const el = document.createElement('div');
      el.className = 'error-toast';
      el.textContent = message;
      document.getElementById('app').appendChild(el);
      setTimeout(() => el.remove(), 5000);
    }

    // Helpers
    function getFilter() {
      if (currentFilter === 'all') return {};
      return { sourceIde: currentFilter };
    }

    function escapeHtml(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    function debounce(fn, ms) {
      let timer;
      return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
      };
    }

    // Init
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
