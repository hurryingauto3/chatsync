/**
 * Network interceptor type definitions.
 *
 * These types describe the raw captured HTTP exchanges before they are
 * parsed into the application's `Conversation` / `Message` model.
 */

// ── Configuration ──

export interface InterceptorConfig {
  /** Whether the interceptor is currently active. */
  enabled: boolean;
  /** Maximum response body size to buffer (bytes). */
  maxBodySizeBytes: number;
}

// ── Endpoint Registry ──

/** Identifies which AI provider an endpoint belongs to. */
export type AIProvider = "openai" | "google" | "anthropic";

/** A registered AI API endpoint pattern. */
export interface AIEndpoint {
  readonly provider: AIProvider;
  readonly hostname: string;
  /** Glob-like path prefix, e.g. "/v1/chat/completions". */
  readonly pathPrefix: string;
  /** Human-readable label for logs. */
  readonly label: string;
}

// ── Captured Data ──

export interface InterceptedRequest {
  readonly method: string;
  readonly hostname: string;
  readonly path: string;
  readonly endpoint: AIEndpoint;
  /** Request body (JSON string). Auth headers are never stored. */
  readonly body: string;
  readonly timestamp: number;
}

export interface InterceptedResponse {
  readonly statusCode: number;
  /** Fully reassembled response body (JSON string or concatenated SSE text). */
  readonly body: string;
  readonly isStreaming: boolean;
  readonly timestamp: number;
}

/** A complete request → response pair ready for parsing. */
export interface InterceptedExchange {
  readonly request: InterceptedRequest;
  readonly response: InterceptedResponse;
}

// ── Parsed Output ──

/** The result of parsing an InterceptedExchange into chat messages. */
export interface ParsedChatExchange {
  /** Which provider originated this exchange. */
  readonly provider: AIProvider;
  /** The model used (e.g. "gpt-4o", "gemini-1.5-pro"). */
  readonly model: string | null;
  /** User messages extracted from the request body. */
  readonly userMessages: readonly ParsedMessage[];
  /** Assistant response extracted from the response body. */
  readonly assistantMessage: ParsedMessage | null;
}

export interface ParsedMessage {
  readonly role: "user" | "assistant" | "system";
  readonly content: string;
}
