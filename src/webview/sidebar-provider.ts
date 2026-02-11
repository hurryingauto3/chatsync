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

    webviewView.webview.onDidReceiveMessage(
      (message: WebviewToExtensionMessage) => {
        void this.handleWebviewMessage(message);
      },
    );

    this.syncEngine.onSyncEvent(() => {
      this.sendSyncStatus();
      this.sendConversations();
    });

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

  private getHtmlContent(_webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("hex");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>ChatSync</title>
  <style nonce="${nonce}">
    /* ── Reset & Base ── */
    *, *::before, *::after {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    :root {
      --radius-sm: 4px;
      --radius-md: 6px;
      --radius-lg: 10px;
      --radius-pill: 100px;
      --gap-xs: 4px;
      --gap-sm: 8px;
      --gap-md: 12px;
      --gap-lg: 16px;
      --gap-xl: 24px;
      --transition: 120ms ease;
    }

    body {
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      line-height: 1.45;
      overflow-x: hidden;
    }

    /* ── Utilities ── */
    .hidden { display: none !important; }

    /* ── App Container ── */
    #app {
      display: flex;
      flex-direction: column;
      height: 100vh;
      overflow: hidden;
    }

    #list-view {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    /* ── Cloud Sync Banner ── */
    .sync-banner {
      padding: var(--gap-md) var(--gap-md);
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.2)));
      display: flex;
      flex-direction: column;
      gap: var(--gap-sm);
    }

    .sync-banner-text {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
    }

    .sync-banner-connected {
      display: flex;
      align-items: center;
      gap: var(--gap-xs);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .status-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .status-dot.online { background: var(--vscode-testing-iconPassed, #388a34); }
    .status-dot.offline { background: var(--vscode-descriptionForeground); opacity: 0.5; }

    /* ── Buttons ── */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: var(--gap-xs);
      border: none;
      cursor: pointer;
      font-family: inherit;
      font-size: var(--vscode-font-size, 13px);
      border-radius: var(--radius-sm);
      transition: background var(--transition), opacity var(--transition);
      outline: none;
      line-height: 1;
    }

    .btn:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    .btn-primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      padding: 6px 12px;
    }
    .btn-primary:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .btn-secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      padding: 6px 12px;
    }
    .btn-secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .btn-ghost {
      background: transparent;
      color: var(--vscode-foreground);
      padding: 4px 8px;
    }
    .btn-ghost:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.1));
    }

    .btn-link {
      background: none;
      border: none;
      color: var(--vscode-textLink-foreground);
      padding: 0;
      font-size: 11px;
      cursor: pointer;
      text-decoration: none;
    }
    .btn-link:hover {
      color: var(--vscode-textLink-activeForeground);
      text-decoration: underline;
    }

    .btn-full { width: 100%; }

    /* ── Search ── */
    .search-container {
      padding: var(--gap-md) var(--gap-md) 0;
    }

    .search-input {
      width: 100%;
      padding: 5px 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: var(--radius-sm);
      font-family: inherit;
      font-size: var(--vscode-font-size, 13px);
      outline: none;
      transition: border-color var(--transition);
    }
    .search-input::placeholder {
      color: var(--vscode-input-placeholderForeground);
    }
    .search-input:focus {
      border-color: var(--vscode-focusBorder);
    }

    /* ── Filter Chips ── */
    .filter-bar {
      display: flex;
      gap: var(--gap-xs);
      padding: var(--gap-sm) var(--gap-md);
      flex-wrap: wrap;
    }

    .chip {
      padding: 2px 10px;
      border-radius: var(--radius-pill);
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.25)));
      background: transparent;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-family: inherit;
      cursor: pointer;
      transition: all var(--transition);
      line-height: 1.6;
    }
    .chip:hover {
      color: var(--vscode-foreground);
      border-color: var(--vscode-foreground);
    }
    .chip.active {
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-color: var(--vscode-badge-background);
    }

    /* ── Status Bar ── */
    .status-bar {
      padding: 0 var(--gap-md) var(--gap-sm);
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      display: flex;
      align-items: center;
      gap: var(--gap-xs);
    }

    /* ── Conversation List ── */
    .conversations-panel {
      flex: 1;
      overflow-y: auto;
      overflow-x: hidden;
    }

    .conv-item {
      padding: var(--gap-sm) var(--gap-md);
      cursor: pointer;
      border-left: 3px solid transparent;
      transition: background var(--transition), border-color var(--transition);
    }
    .conv-item:hover {
      background: var(--vscode-list-hoverBackground);
    }
    .conv-item:active {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground);
    }

    .conv-item + .conv-item {
      border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.1)));
    }

    .conv-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 2px;
    }

    .conv-badge {
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: var(--radius-pill);
      text-transform: uppercase;
      letter-spacing: 0.3px;
      color: #fff;
    }
    .badge-copilot      { background: #6f42c1; }
    .badge-cursor        { background: #0078d4; }
    .badge-antigravity   { background: #c73a3a; }
    .badge-claude-code   { background: #c27b1a; }

    .conv-date {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
    }

    .conv-title {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      margin-bottom: 2px;
      font-size: var(--vscode-font-size, 13px);
    }

    .conv-meta {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    /* ── Empty State ── */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: var(--gap-xl) var(--gap-lg);
      text-align: center;
      gap: var(--gap-sm);
      color: var(--vscode-descriptionForeground);
      flex: 1;
    }

    .empty-state-icon {
      font-size: 32px;
      opacity: 0.3;
      margin-bottom: var(--gap-sm);
    }

    .empty-state-title {
      font-size: 13px;
      font-weight: 500;
      color: var(--vscode-foreground);
    }

    .empty-state-desc {
      font-size: 12px;
      line-height: 1.5;
      max-width: 240px;
    }

    /* ── Detail View ── */
    .detail-panel {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    .detail-header {
      display: flex;
      align-items: center;
      gap: var(--gap-sm);
      padding: var(--gap-sm) var(--gap-md);
      border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.2)));
      flex-shrink: 0;
    }

    .detail-header-back {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 4px;
      border-radius: var(--radius-sm);
      font-size: 16px;
      line-height: 1;
      display: flex;
      align-items: center;
    }
    .detail-header-back:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.1));
    }

    .detail-header-title {
      font-weight: 600;
      font-size: var(--vscode-font-size, 13px);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
    }

    .detail-messages {
      flex: 1;
      overflow-y: auto;
      padding: var(--gap-sm) 0;
    }

    .msg-item {
      padding: var(--gap-sm) var(--gap-md);
      border-left: 3px solid transparent;
    }

    .msg-item + .msg-item {
      margin-top: 2px;
    }

    .msg-user {
      border-left-color: var(--vscode-terminal-ansiBlue, #569cd6);
      background: color-mix(in srgb, var(--vscode-terminal-ansiBlue, #569cd6) 6%, transparent);
    }

    .msg-assistant {
      border-left-color: var(--vscode-terminal-ansiGreen, #6a9955);
      background: color-mix(in srgb, var(--vscode-terminal-ansiGreen, #6a9955) 6%, transparent);
    }

    .msg-system {
      border-left-color: var(--vscode-terminal-ansiYellow, #d7ba7d);
      background: color-mix(in srgb, var(--vscode-terminal-ansiYellow, #d7ba7d) 6%, transparent);
      font-style: italic;
    }

    .msg-role {
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      margin-bottom: 3px;
      color: var(--vscode-descriptionForeground);
    }

    .msg-model {
      font-weight: 400;
      opacity: 0.7;
      text-transform: none;
      letter-spacing: 0;
    }

    .msg-content {
      white-space: pre-wrap;
      word-break: break-word;
      line-height: 1.55;
      font-size: var(--vscode-editor-font-size, 13px);
    }

    .detail-footer {
      padding: var(--gap-sm) var(--gap-md);
      border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.2)));
      flex-shrink: 0;
    }

    /* ── Error Toast ── */
    .toast {
      position: fixed;
      bottom: var(--gap-md);
      left: var(--gap-md);
      right: var(--gap-md);
      padding: var(--gap-sm) var(--gap-md);
      border-radius: var(--radius-md);
      font-size: 12px;
      z-index: 100;
      animation: toastIn 200ms ease;
      border: 1px solid;
    }

    .toast-error {
      background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
      border-color: var(--vscode-inputValidation-errorBorder, #be1100);
      color: var(--vscode-foreground);
    }

    @keyframes toastIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* ── Scrollbar ── */
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background);
      border-radius: 3px;
    }
    ::-webkit-scrollbar-thumb:hover {
      background: var(--vscode-scrollbarSlider-hoverBackground);
    }
  </style>
</head>
<body>
  <div id="app">

    <!-- SYNC BANNER (shown when not authenticated) -->
    <div id="sync-banner" class="sync-banner hidden">
      <div class="sync-banner-text">
        Sign in with GitHub to sync conversations across machines.
      </div>
      <button id="sign-in-btn" class="btn btn-primary btn-full">Sign in with GitHub</button>
    </div>

    <!-- SYNC STATUS (shown when authenticated) -->
    <div id="sync-connected" class="sync-banner hidden">
      <div class="sync-banner-connected">
        <span id="status-dot" class="status-dot offline"></span>
        <span id="sync-status-text">Offline</span>
      </div>
      <button id="sign-out-btn" class="btn-link">Sign out</button>
    </div>

    <!-- LIST VIEW -->
    <div id="list-view">
      <div class="search-container">
        <input type="text" id="search-input" class="search-input" placeholder="Search conversations..." />
      </div>
      <div class="filter-bar">
        <button class="chip active" data-filter="all">All</button>
        <button class="chip" data-filter="copilot">Copilot</button>
        <button class="chip" data-filter="cursor">Cursor</button>
        <button class="chip" data-filter="antigravity">Antigravity</button>
        <button class="chip" data-filter="claude-code">Claude</button>
      </div>

      <div id="status-bar" class="status-bar hidden"></div>

      <div id="conversations-list" class="conversations-panel"></div>

      <div id="empty-state" class="empty-state hidden">
        <div class="empty-state-icon">&#9776;</div>
        <div class="empty-state-title">No conversations yet</div>
        <div class="empty-state-desc">
          ChatSync will detect conversations from Copilot, Cursor, Claude Code, and Antigravity automatically.
        </div>
      </div>
    </div>

    <!-- DETAIL VIEW -->
    <div id="detail-view" class="detail-panel hidden">
      <div class="detail-header">
        <button id="back-btn" class="detail-header-back" title="Back">&#8592;</button>
        <div id="detail-title" class="detail-header-title"></div>
      </div>
      <div id="messages-list" class="detail-messages"></div>
      <div class="detail-footer">
        <button id="continue-btn" class="btn btn-primary btn-full">Continue in Chat</button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // ── State ──
    let currentFilter = 'all';
    let currentConversationId = null;
    let isAuthenticated = false;

    // ── Elements ──
    const $ = (id) => document.getElementById(id);
    const syncBanner = $('sync-banner');
    const syncConnected = $('sync-connected');
    const signInBtn = $('sign-in-btn');
    const signOutBtn = $('sign-out-btn');
    const searchInput = $('search-input');
    const filterChips = document.querySelectorAll('.chip');
    const statusBar = $('status-bar');
    const convList = $('conversations-list');
    const emptyState = $('empty-state');
    const listView = $('list-view');
    const detailView = $('detail-view');
    const detailTitle = $('detail-title');
    const messagesList = $('messages-list');
    const backBtn = $('back-btn');
    const continueBtn = $('continue-btn');
    const statusDot = $('status-dot');
    const syncStatusText = $('sync-status-text');

    // ── Event Listeners ──

    signInBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'signIn' });
    });

    signOutBtn.addEventListener('click', () => {
      vscode.postMessage({ type: 'signOut' });
    });

    searchInput.addEventListener('input', debounce((e) => {
      const query = e.target.value.trim();
      if (query.length > 0) {
        vscode.postMessage({ type: 'search', query });
      } else {
        vscode.postMessage({ type: 'getConversations', filter: getFilter() });
      }
    }, 250));

    filterChips.forEach(chip => {
      chip.addEventListener('click', () => {
        filterChips.forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        currentFilter = chip.dataset.filter;
        vscode.postMessage({ type: 'getConversations', filter: getFilter() });
      });
    });

    backBtn.addEventListener('click', () => {
      showListView();
    });

    continueBtn.addEventListener('click', () => {
      if (currentConversationId) {
        vscode.postMessage({ type: 'continueConversation', conversationId: currentConversationId });
      }
    });

    // ── Message Handler ──

    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'authState':
          isAuthenticated = msg.state.authenticated;
          updateAuthUI();
          break;

        case 'conversations':
        case 'searchResults':
          renderConversations(msg.data);
          break;

        case 'messages':
          renderMessages(msg.data);
          break;

        case 'syncStatus':
          renderSyncStatus(msg.status);
          break;

        case 'error':
          showToast(msg.message);
          break;
      }
    });

    // ── UI Functions ──

    function updateAuthUI() {
      if (isAuthenticated) {
        syncBanner.classList.add('hidden');
        syncConnected.classList.remove('hidden');
      } else {
        syncBanner.classList.remove('hidden');
        syncConnected.classList.add('hidden');
      }
    }

    function showListView() {
      listView.classList.remove('hidden');
      detailView.classList.add('hidden');
      currentConversationId = null;
    }

    function showDetailView(title) {
      listView.classList.add('hidden');
      detailView.classList.remove('hidden');
      detailTitle.textContent = title;
    }

    function renderConversations(conversations) {
      convList.innerHTML = '';

      if (!conversations || conversations.length === 0) {
        convList.classList.add('hidden');
        emptyState.classList.remove('hidden');
        return;
      }

      convList.classList.remove('hidden');
      emptyState.classList.add('hidden');

      conversations.forEach(conv => {
        const el = document.createElement('div');
        el.className = 'conv-item';

        const date = formatDate(conv.updatedAt);
        const msgCount = conv.messages ? conv.messages.length : 0;
        const badgeClass = 'badge-' + esc(conv.sourceIde);
        const ideLabel = formatIde(conv.sourceIde);

        el.innerHTML =
          '<div class="conv-header">' +
            '<span class="conv-badge ' + badgeClass + '">' + esc(ideLabel) + '</span>' +
            '<span class="conv-date">' + esc(date) + '</span>' +
          '</div>' +
          '<div class="conv-title">' + esc(conv.title) + '</div>' +
          '<div class="conv-meta">' + msgCount + ' message' + (msgCount !== 1 ? 's' : '') + '</div>';

        el.addEventListener('click', () => {
          currentConversationId = conv.id;
          vscode.postMessage({ type: 'getMessages', conversationId: conv.id });
          showDetailView(conv.title);
        });

        convList.appendChild(el);
      });
    }

    function renderMessages(messages) {
      messagesList.innerHTML = '';

      if (!messages || messages.length === 0) {
        messagesList.innerHTML = '<div class="empty-state"><div class="empty-state-desc">No messages</div></div>';
        return;
      }

      messages.forEach(msg => {
        const el = document.createElement('div');
        el.className = 'msg-item msg-' + msg.role;

        const modelSpan = msg.sourceModel
          ? ' <span class="msg-model">' + esc(msg.sourceModel) + '</span>'
          : '';

        el.innerHTML =
          '<div class="msg-role">' + esc(msg.role) + modelSpan + '</div>' +
          '<div class="msg-content">' + esc(msg.content) + '</div>';

        messagesList.appendChild(el);
      });

      // Scroll to top on load
      messagesList.scrollTop = 0;
    }

    function renderSyncStatus(status) {
      if (status.connected) {
        statusDot.className = 'status-dot online';
      } else {
        statusDot.className = 'status-dot offline';
      }

      const parts = [];
      parts.push(status.connected ? 'Connected' : 'Local only');

      if (status.pendingUploads > 0) {
        parts.push(status.pendingUploads + ' pending');
      }
      if (status.lastSyncedAt) {
        parts.push('Synced ' + formatTime(status.lastSyncedAt));
      }

      syncStatusText.textContent = parts.join(' · ');

      // Show status bar if there's pending info
      if (status.pendingUploads > 0 || status.lastSyncedAt) {
        statusBar.textContent = parts.slice(1).join(' · ');
        statusBar.classList.remove('hidden');
      }
    }

    function showToast(message) {
      const existing = document.querySelector('.toast');
      if (existing) existing.remove();

      const el = document.createElement('div');
      el.className = 'toast toast-error';
      el.textContent = message;
      document.getElementById('app').appendChild(el);
      setTimeout(() => el.remove(), 5000);
    }

    // ── Helpers ──

    function getFilter() {
      if (currentFilter === 'all') return {};
      return { sourceIde: currentFilter };
    }

    function esc(str) {
      if (!str) return '';
      const el = document.createElement('span');
      el.textContent = str;
      return el.innerHTML;
    }

    function formatDate(iso) {
      if (!iso) return '';
      const d = new Date(iso);
      const now = new Date();
      const diff = now - d;

      if (diff < 86400000 && d.getDate() === now.getDate()) {
        return 'Today ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      }
      if (diff < 172800000) {
        return 'Yesterday';
      }
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    function formatTime(iso) {
      if (!iso) return '';
      return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }

    function formatIde(ide) {
      const labels = {
        'copilot': 'Copilot',
        'cursor': 'Cursor',
        'antigravity': 'Antigravity',
        'claude-code': 'Claude',
      };
      return labels[ide] || ide;
    }

    function debounce(fn, ms) {
      let timer;
      return function(...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), ms);
      };
    }

    // ── Init ──
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
  }
}
