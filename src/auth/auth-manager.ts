import * as vscode from "vscode";
import type { AuthState, SupabaseConfig } from "../models/types.js";
import { SharedConfig } from "../utils/shared-config.js";

const GITHUB_SCOPES = ["read:user", "user:email"];
const SECRET_KEY_SUPABASE_URL = "chatsync.supabaseUrl";
const SECRET_KEY_SUPABASE_ANON = "chatsync.supabaseAnonKey";
const SECRET_KEY_SUPABASE_JWT = "chatsync.supabaseJwt";
const SECRET_KEY_SUPABASE_REFRESH = "chatsync.supabaseRefreshToken";

interface TokenResponse {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly user: {
    readonly id: string;
  };
}

export class AuthManager implements vscode.Disposable {
  private readonly _onAuthStateChanged = new vscode.EventEmitter<AuthState>();
  public readonly onAuthStateChanged = this._onAuthStateChanged.event;

  private _authState: AuthState = {
    authenticated: false,
    userId: null,
    githubUsername: null,
  };

  private _refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly _disposables: vscode.Disposable[] = [];

  constructor(private readonly secrets: vscode.SecretStorage) {
    this._disposables.push(this._onAuthStateChanged);
  }

  get authState(): AuthState {
    return this._authState;
  }

  async initialize(): Promise<void> {
    // 1. Sync secrets from SharedConfig if missing
    const shared = SharedConfig.load();
    if (Object.keys(shared).length > 0) {
      console.log("[AuthManager] Loading shared config from ~/.chatsync/config.json");
    }
    if (shared.supabaseUrl) {
      const currentUrl = await this.secrets.get(SECRET_KEY_SUPABASE_URL);
      if (!currentUrl) {
        await this.secrets.store(SECRET_KEY_SUPABASE_URL, shared.supabaseUrl);
      }
    }
    if (shared.supabaseAnonKey) {
      const currentKey = await this.secrets.get(SECRET_KEY_SUPABASE_ANON);
      if (!currentKey) {
        await this.secrets.store(SECRET_KEY_SUPABASE_ANON, shared.supabaseAnonKey);
      }
    }
    if (shared.supabaseJwt) {
      const currentJwt = await this.secrets.get(SECRET_KEY_SUPABASE_JWT);
      if (!currentJwt) {
        await this.secrets.store(SECRET_KEY_SUPABASE_JWT, shared.supabaseJwt);
      }
    }
    if (shared.supabaseRefreshToken) {
      const currentRefresh = await this.secrets.get(SECRET_KEY_SUPABASE_REFRESH);
      if (!currentRefresh) {
        await this.secrets.store(SECRET_KEY_SUPABASE_REFRESH, shared.supabaseRefreshToken);
      }
    }

    // 2. Check if we already have a valid JWT or are in anon-key-mode
    const jwt = await this.secrets.get(SECRET_KEY_SUPABASE_JWT);
    if (jwt === "anon-key-mode") {
      // Previously signed in with anon-key-mode — generate deterministic UUID
      const crypto = await import("crypto");
      const label = shared.supabaseJwt === "anon-key-mode" ? "user" : "anonymous";
      const hash = crypto.createHash("sha256").update(label).digest("hex");
      const anonUserId = [
        hash.slice(0, 8),
        hash.slice(8, 12),
        "4" + hash.slice(13, 16),
        "a" + hash.slice(17, 20),
        hash.slice(20, 32),
      ].join("-");
      this._authState = {
        authenticated: true,
        userId: anonUserId,
        githubUsername: null,
      };
      this._onAuthStateChanged.fire(this._authState);
      return;
    }
    if (jwt) {
      const userId = this.parseUserIdFromJwt(jwt);
      if (userId && !this.isJwtExpired(jwt)) {
        this._authState = {
          authenticated: true,
          userId,
          githubUsername: null,
        };
        this._onAuthStateChanged.fire(this._authState);
        this.scheduleRefresh(jwt);
        return;
      }
      // JWT expired, try refresh
      await this.refreshToken();
    }
  }

  async signIn(): Promise<AuthState> {
    const config = await this.getSupabaseConfig();
    if (!config) {
      await this.promptForSupabaseConfig();
      const retryConfig = await this.getSupabaseConfig();
      if (!retryConfig) {
        throw new Error("Supabase configuration required to sign in");
      }
      return this.performSignIn(retryConfig);
    }
    return this.performSignIn(config);
  }

  private async performSignIn(config: SupabaseConfig): Promise<AuthState> {
    // Get GitHub session from VS Code's built-in auth (for identity)
    let githubUsername = "anonymous";
    try {
      const session = await vscode.authentication.getSession(
        "github",
        GITHUB_SCOPES,
        { createIfNone: true },
      );
      githubUsername = session.account.label;
    } catch {
      // GitHub auth not available — continue without it
    }

    // Try Supabase sign-in using the built-in anonymous auth
    const { createClient } = await import("@supabase/supabase-js");
    const tempClient = createClient(config.url, config.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    try {
      // Try anonymous sign-in first (requires Supabase anon auth enabled)
      const { data, error } = await tempClient.auth.signInAnonymously();
      if (error) {
        throw error;
      }

      const accessToken = data.session?.access_token ?? "";
      const refreshToken = data.session?.refresh_token ?? "";
      const userId = data.user?.id ?? crypto.randomUUID();

      // Store tokens securely
      await this.secrets.store(SECRET_KEY_SUPABASE_JWT, accessToken);
      await this.secrets.store(SECRET_KEY_SUPABASE_REFRESH, refreshToken);

      SharedConfig.save({
        supabaseJwt: accessToken,
        supabaseRefreshToken: refreshToken,
      });

      this._authState = {
        authenticated: true,
        userId,
        githubUsername,
      };

      this._onAuthStateChanged.fire(this._authState);
      if (accessToken) {
        this.scheduleRefresh(accessToken);
      }

      return this._authState;
    } catch {
      // Anonymous auth not enabled — fall back to anon-key-only mode.
      // This works if RLS is disabled or uses anon key policies.
      // Generate a deterministic UUID from the GitHub username
      const crypto = await import("crypto");
      const hash = crypto.createHash("sha256").update(githubUsername).digest("hex");
      const userId = [
        hash.slice(0, 8),
        hash.slice(8, 12),
        "4" + hash.slice(13, 16), // UUID v4 format
        "a" + hash.slice(17, 20), // variant bits
        hash.slice(20, 32),
      ].join("-");

      // Store a sentinel value so we know we're "authenticated"
      await this.secrets.store(SECRET_KEY_SUPABASE_JWT, "anon-key-mode");

      SharedConfig.save({
        supabaseJwt: "anon-key-mode",
      });

      this._authState = {
        authenticated: true,
        userId,
        githubUsername,
      };

      this._onAuthStateChanged.fire(this._authState);
      return this._authState;
    }
  }

  async signOut(): Promise<void> {
    await this.secrets.delete(SECRET_KEY_SUPABASE_JWT);
    await this.secrets.delete(SECRET_KEY_SUPABASE_REFRESH);
    
    // Also remove from shared config
    SharedConfig.save({
      supabaseJwt: undefined,
      supabaseRefreshToken: undefined,
    });

    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
      this._refreshTimer = undefined;
    }

    this._authState = {
      authenticated: false,
      userId: null,
      githubUsername: null,
    };
    this._onAuthStateChanged.fire(this._authState);
  }

  async getAccessToken(): Promise<string | null> {
    const jwt = await this.secrets.get(SECRET_KEY_SUPABASE_JWT);
    if (!jwt) {
      return null;
    }
    // In anon-key-mode, no JWT is used — the client works with just the anon key
    if (jwt === "anon-key-mode") {
      return null;
    }
    if (this.isJwtExpired(jwt)) {
      return this.refreshToken();
    }
    return jwt;
  }

  async getSupabaseConfig(): Promise<SupabaseConfig | null> {
    const url = await this.secrets.get(SECRET_KEY_SUPABASE_URL);
    const anonKey = await this.secrets.get(SECRET_KEY_SUPABASE_ANON);
    if (!url || !anonKey) {
      return null;
    }
    return { url, anonKey };
  }

  async promptForSupabaseConfig(): Promise<void> {
    const url = await vscode.window.showInputBox({
      title: "ChatSync: Supabase Project URL",
      prompt: "Enter your Supabase project URL (e.g., https://xxx.supabase.co)",
      placeHolder: "https://your-project.supabase.co",
      ignoreFocusOut: true,
      validateInput: (value: string) => {
        if (!value.startsWith("https://") || !value.includes("supabase")) {
          return "Must be a valid Supabase URL (https://xxx.supabase.co)";
        }
        return null;
      },
    });
    if (!url) {
      return;
    }

    const anonKey = await vscode.window.showInputBox({
      title: "ChatSync: Supabase Anon Key",
      prompt: "Enter your Supabase anon (public) key from the API settings",
      placeHolder: "eyJhbGciOiJIUzI1NiIs...",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value: string) => {
        if (value.length < 30) {
          return "Key seems too short. Find it in Supabase Dashboard → Settings → API";
        }
        return null;
      },
    });
    if (!anonKey) {
      return;
    }

    await this.secrets.store(SECRET_KEY_SUPABASE_URL, url.replace(/\/$/, ""));
    await this.secrets.store(SECRET_KEY_SUPABASE_ANON, anonKey);

    // Also store in shared config
    SharedConfig.save({
      supabaseUrl: url.replace(/\/$/, ""),
      supabaseAnonKey: anonKey,
    });
  }

  private async refreshToken(): Promise<string | null> {
    const refreshToken = await this.secrets.get(SECRET_KEY_SUPABASE_REFRESH);
    const config = await this.getSupabaseConfig();
    if (!refreshToken || !config) {
      return null;
    }

    try {
      const response = await fetch(
        `${config.url}/auth/v1/token?grant_type=refresh_token`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "apikey": config.anonKey,
          },
          body: JSON.stringify({ refresh_token: refreshToken }),
        },
      );

      if (!response.ok) {
        // Refresh failed — force re-auth
        await this.signOut();
        return null;
      }

      const tokenData: TokenResponse = await response.json() as TokenResponse;
      await this.secrets.store(SECRET_KEY_SUPABASE_JWT, tokenData.access_token);
      await this.secrets.store(SECRET_KEY_SUPABASE_REFRESH, tokenData.refresh_token);

      // Update shared config
      SharedConfig.save({
        supabaseJwt: tokenData.access_token,
        supabaseRefreshToken: tokenData.refresh_token,
      });

      this._authState = {
        ...this._authState,
        authenticated: true,
        userId: tokenData.user.id,
      };
      this._onAuthStateChanged.fire(this._authState);
      this.scheduleRefresh(tokenData.access_token);

      return tokenData.access_token;
    } catch {
      return null;
    }
  }

  private scheduleRefresh(jwt: string): void {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
    }

    const payload = this.decodeJwtPayload(jwt);
    if (!payload?.exp) {
      return;
    }

    // Refresh 5 minutes before expiry
    const expiresInMs = (payload.exp * 1000) - Date.now() - (5 * 60 * 1000);
    if (expiresInMs > 0) {
      this._refreshTimer = setTimeout(() => {
        void this.refreshToken();
      }, expiresInMs);
    }
  }

  private isJwtExpired(jwt: string): boolean {
    const payload = this.decodeJwtPayload(jwt);
    if (!payload?.exp) {
      return true;
    }
    return Date.now() >= payload.exp * 1000;
  }

  private parseUserIdFromJwt(jwt: string): string | null {
    const payload = this.decodeJwtPayload(jwt);
    return payload?.sub ?? null;
  }

  private decodeJwtPayload(jwt: string): { exp?: number; sub?: string } | null {
    try {
      const parts = jwt.split(".");
      if (parts.length !== 3 || !parts[1]) {
        return null;
      }
      const decoded = Buffer.from(parts[1], "base64url").toString("utf-8");
      return JSON.parse(decoded) as { exp?: number; sub?: string };
    } catch {
      return null;
    }
  }

  dispose(): void {
    if (this._refreshTimer) {
      clearTimeout(this._refreshTimer);
    }
    for (const d of this._disposables) {
      d.dispose();
    }
  }
}
