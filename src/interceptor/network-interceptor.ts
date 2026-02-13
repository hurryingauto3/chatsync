/**
 * Main network interceptor orchestrator.
 *
 * Manages the lifecycle of HTTP/HTTPS and fetch patches, emits captured
 * exchanges via a VS Code event, and provides enable/disable toggling.
 */

import * as vscode from "vscode";

import { patchHttps } from "./https-patcher.js";
import { patchFetch } from "./fetch-patcher.js";
import { patchHttp2 } from "./http2-patcher.js";
import type { InterceptedExchange, InterceptorConfig } from "./types.js";

export class NetworkInterceptor implements vscode.Disposable {
  private readonly _onExchange = new vscode.EventEmitter<InterceptedExchange>();
  /** Fires for each captured request/response pair. */
  public readonly onExchange: vscode.Event<InterceptedExchange> =
    this._onExchange.event;

  private httpsPatch: { unpatch: () => void } | null = null;
  private fetchPatch: { unpatch: () => void } | null = null;
  private http2Patch: { unpatch: () => void } | null = null;
  private isEnabled = false;

  constructor(
    private config: InterceptorConfig,
    private readonly log: vscode.OutputChannel,
  ) {}

  /** Whether the interceptor is currently active. */
  get enabled(): boolean {
    return this.isEnabled;
  }

  /**
   * Enable the interceptor — install monkey-patches.
   * Safe to call multiple times (idempotent).
   */
  enable(): void {
    if (this.isEnabled) {
      this.log.appendLine("[interceptor] Already enabled, skipping");
      return;
    }

    this.log.appendLine("[interceptor] Enabling network interceptor...");

    try {
      this.httpsPatch = patchHttps(
        this.config.maxBodySizeBytes,
        this.log,
        (exchange) => this.handleExchange(exchange),
      );
    } catch (err) {
      this.log.appendLine(
        `[interceptor] ERROR: Failed to patch HTTP/HTTPS: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      this.fetchPatch = patchFetch(
        this.config.maxBodySizeBytes,
        this.log,
        (exchange) => this.handleExchange(exchange),
      );
    } catch (err) {
      this.log.appendLine(
        `[interceptor] ERROR: Failed to patch fetch: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      this.http2Patch = patchHttp2(
        this.config.maxBodySizeBytes,
        this.log,
        (exchange) => this.handleExchange(exchange),
      );
    } catch (err) {
      this.log.appendLine(
        `[interceptor] ERR: Failed to patch http2: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.isEnabled = true;
    this.log.appendLine("[interceptor] ✅ Network interceptor enabled");
  }

  /**
   * Disable the interceptor — restore original functions.
   * Safe to call multiple times (idempotent).
   */
  disable(): void {
    if (!this.isEnabled) {
      this.log.appendLine("[interceptor] Already disabled, skipping");
      return;
    }

    this.log.appendLine("[interceptor] Disabling network interceptor...");

    try {
      this.httpsPatch?.unpatch();
      this.httpsPatch = null;
    } catch (err) {
      this.log.appendLine(
        `[interceptor] WARN: Error unpatching HTTP/HTTPS: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      this.fetchPatch?.unpatch();
      this.fetchPatch = null;
    } catch (err) {
      this.log.appendLine(
        `[interceptor] WARN: Error unpatching fetch: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (this.http2Patch) {
      this.http2Patch.unpatch();
      this.http2Patch = null;
    }
    this.isEnabled = false;
    this.log.appendLine("[interceptor] ❌ Network interceptor disabled");
  }

  /** Toggle between enabled/disabled. Returns the new state. */
  toggle(): boolean {
    if (this.isEnabled) {
      this.disable();
    } else {
      this.enable();
    }
    return this.isEnabled;
  }

  /** Update configuration. Takes effect immediately. */
  updateConfig(config: InterceptorConfig): void {
    this.config = config;

    if (config.enabled && !this.isEnabled) {
      this.enable();
    } else if (!config.enabled && this.isEnabled) {
      this.disable();
    }
  }

  /** Clean up all patches and event emitters. */
  dispose(): void {
    this.disable();
    this._onExchange.dispose();
  }

  // ── Private ──

  private handleExchange(exchange: InterceptedExchange): void {
    try {
      // Only emit for successful responses (2xx)
      if (exchange.response.statusCode >= 200 && exchange.response.statusCode < 300) {
        this._onExchange.fire(exchange);
      } else {
        this.log.appendLine(
          `[interceptor] Skipping non-2xx response: ${String(exchange.response.statusCode)} for ${exchange.request.endpoint.label}`,
        );
      }
    } catch (err) {
      this.log.appendLine(
        `[interceptor] WARN: Error handling exchange: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
