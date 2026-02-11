import * as vscode from "vscode";
import type { AuthState, SupabaseConfig } from "../models/types.js";

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
    // Check if we already have a valid JWT
    const jwt = await this.secrets.get(SECRET_KEY_SUPABASE_JWT);
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
    // Get GitHub session from VS Code's built-in auth
    const session = await vscode.authentication.getSession(
      "github",
      GITHUB_SCOPES,
      { createIfNone: true },
    );

    // Exchange GitHub token for Supabase JWT via Edge Function
    const response = await fetch(
      `${config.url}/functions/v1/github-auth`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${config.anonKey}`,
        },
        body: JSON.stringify({
          github_token: session.accessToken,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Auth failed: ${errorText}`);
    }

    const tokenData: TokenResponse = await response.json() as TokenResponse;

    // Store tokens securely
    await this.secrets.store(SECRET_KEY_SUPABASE_JWT, tokenData.access_token);
    await this.secrets.store(SECRET_KEY_SUPABASE_REFRESH, tokenData.refresh_token);

    this._authState = {
      authenticated: true,
      userId: tokenData.user.id,
      githubUsername: session.account.label,
    };

    this._onAuthStateChanged.fire(this._authState);
    this.scheduleRefresh(tokenData.access_token);

    return this._authState;
  }

  async signOut(): Promise<void> {
    await this.secrets.delete(SECRET_KEY_SUPABASE_JWT);
    await this.secrets.delete(SECRET_KEY_SUPABASE_REFRESH);

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
