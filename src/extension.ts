import * as vscode from "vscode";
import * as fs from "node:fs";
import { AuthManager } from "./auth/auth-manager.js";
import { SupabaseClientWrapper } from "./sync/supabase-client.js";
import { LocalCache } from "./sync/local-cache.js";
import { SyncEngine } from "./sync/sync-engine.js";
import { SidebarProvider } from "./webview/sidebar-provider.js";
import { ChatSyncParticipant } from "./chat/chat-participant.js";
import { ClaudeCodeExtractor } from "./extractors/claude-code-extractor.js";
import { CopilotExtractor } from "./extractors/copilot-extractor.js";
import { CursorExtractor } from "./extractors/cursor-extractor.js";
import { AntigravityExtractor } from "./extractors/antigravity-extractor.js";
import { NetworkInterceptor } from "./interceptor/network-interceptor.js";
import { parseExchangeToConversation } from "./interceptor/parsers/parser-registry.js";
import type { ChatExtractor } from "./models/types.js";
import type { InterceptorConfig } from "./interceptor/types.js";

let syncEngine: SyncEngine | undefined;
let networkInterceptor: NetworkInterceptor | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // Ensure global storage directory exists
  const storagePath = context.globalStorageUri.fsPath;
  if (!fs.existsSync(storagePath)) {
    fs.mkdirSync(storagePath, { recursive: true });
  }

  // ── Auth ──
  const authManager = new AuthManager(context.secrets);
  context.subscriptions.push(authManager);

  // ── Supabase ──
  const supabaseClient = new SupabaseClientWrapper(authManager);
  context.subscriptions.push(supabaseClient);

  // ── Local Cache ──
  const localCache = new LocalCache(context.globalStorageUri);
  context.subscriptions.push(localCache);

  // ── Extractors ──
  const extractors: ChatExtractor[] = [
    new ClaudeCodeExtractor(),
    new CopilotExtractor(),
    new CursorExtractor(),
    new AntigravityExtractor(),
  ];

  // ── Sync Engine ──
  syncEngine = new SyncEngine(authManager, supabaseClient, localCache, extractors);
  context.subscriptions.push(syncEngine);

  // ── Sidebar Webview ──
  const sidebarProvider = new SidebarProvider(
    context.extensionUri,
    syncEngine,
    authManager,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewType,
      sidebarProvider,
    ),
  );

  // ── Chat Participant ──
  const chatParticipant = new ChatSyncParticipant(syncEngine);
  context.subscriptions.push(chatParticipant);

  // ── Network Interceptor ──
  const interceptorLog = vscode.window.createOutputChannel("ChatSync Interceptor");
  const interceptorConfig = readInterceptorConfig();
  networkInterceptor = new NetworkInterceptor(interceptorConfig, interceptorLog);
  context.subscriptions.push(networkInterceptor);
  context.subscriptions.push(interceptorLog);

  // Wire interceptor exchanges → parser → sync engine
  context.subscriptions.push(
    networkInterceptor.onExchange((exchange) => {
      try {
        const conversation = parseExchangeToConversation(exchange);
        if (conversation && syncEngine) {
          interceptorLog.appendLine(
            `[interceptor] ✅ Captured & Parsed: "${conversation.title}" from ${conversation.sourceIde} (${conversation.messages.length} messages)`,
          );
          syncEngine.handleExtractedConversation(conversation);
        } else if (!conversation) {
           // Skip logging ping/pong or non-chat exchanges unless verbose
        }
      } catch (err) {
        interceptorLog.appendLine(
          `[interceptor] WARN: Failed to parse exchange: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }),
  );

  // Auto-enable if configured
  if (interceptorConfig.enabled) {
    networkInterceptor.enable();
  }

  // ── Commands ──
  context.subscriptions.push(
    vscode.commands.registerCommand("chatsync.signIn", () => {
      void authManager.signIn().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "Sign in failed";
        void vscode.window.showErrorMessage(`ChatSync: ${msg}`);
      });
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("chatsync.signOut", () => {
      void authManager.signOut();
      void vscode.window.showInformationMessage("ChatSync: Signed out");
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("chatsync.syncNow", () => {
      void syncEngine?.fullSync();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("chatsync.configureSupabase", () => {
      void authManager.promptForSupabaseConfig();
    }),
  );

  // Test network command
  context.subscriptions.push(
    vscode.commands.registerCommand("chatsync.testNetwork", async () => {
      interceptorLog.appendLine("[interceptor] Running network diagnostic test...");
      try {
        const res = await fetch("https://www.google.com");
        interceptorLog.appendLine(`[interceptor] Diagnostic fetch status: ${res.status}`);

        // Also list all output channels (to see if we can scrape logs)
        // Unfortunately VS Code API doesn't expose a list of all channels directly to extensions.
        // But we can check for specific known ones or rely on the user to tell us.
        interceptorLog.appendLine("[interceptor] Checking for known output channels...");
        
        // This is a bit of a hack/guess, but we can try to look for known IDs if we had access to them
        // For now, we'll just log that we are checking.
      } catch (err) {
        interceptorLog.appendLine(`[interceptor] Diagnostic fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }),
  );

  // Toggle interceptor command
  context.subscriptions.push(
    vscode.commands.registerCommand("chatsync.toggleInterceptor", () => {
      if (!networkInterceptor) {
        return;
      }
      const isEnabled = networkInterceptor.toggle();
      const label = isEnabled ? "enabled" : "disabled";
      void vscode.window.showInformationMessage(
        `ChatSync: AI Chat Capture ${label}`,
      );
    }),
  );

  // Listen for config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("chatsync.interceptor")) {
        const newConfig = readInterceptorConfig();
        networkInterceptor?.updateConfig(newConfig);
      }
    }),
  );

  // ── Initialize async components ──
  void initializeAsync(localCache, authManager, supabaseClient, syncEngine);
}

async function initializeAsync(
  localCache: LocalCache,
  authManager: AuthManager,
  supabaseClient: SupabaseClientWrapper,
  engine: SyncEngine,
): Promise<void> {
  const log = vscode.window.createOutputChannel("ChatSync");

  try {
    log.appendLine("[init] Initializing local cache...");
    await localCache.initialize();
    log.appendLine("[init] Local cache OK");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.appendLine(`[init] Local cache FAILED: ${msg}`);
    void vscode.window.showErrorMessage(`ChatSync: Cache init failed: ${msg}`);
    return; // Can't proceed without cache
  }

  try {
    log.appendLine("[init] Initializing auth...");
    await authManager.initialize();
    log.appendLine(`[init] Auth OK (authenticated: ${authManager.authState.authenticated})`);

    if (authManager.authState.authenticated) {
      log.appendLine("[init] Initializing Supabase client...");
      await supabaseClient.initialize();
      log.appendLine("[init] Supabase client OK");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.appendLine(`[init] Auth/Supabase init failed (non-fatal): ${msg}`);
  }

  try {
    log.appendLine("[init] Initializing sync engine...");
    await engine.initialize();
    log.appendLine("[init] Sync engine OK");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.appendLine(`[init] Sync engine FAILED: ${msg}`);
  }
}

export function deactivate(): void {
  syncEngine = undefined;
  networkInterceptor = undefined;
}

/** Read interceptor settings from VS Code configuration. */
function readInterceptorConfig(): InterceptorConfig {
  const cfg = vscode.workspace.getConfiguration("chatsync.interceptor");
  return {
    enabled: cfg.get<boolean>("enabled", false),
    maxBodySizeBytes: cfg.get<number>("maxBodySizeKB", 512) * 1024,
  };
}
