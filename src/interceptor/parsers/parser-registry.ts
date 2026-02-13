/**
 * Parser registry — maps AI providers to their exchange parsers.
 *
 * Converts raw `InterceptedExchange` objects into the application's
 * `Conversation` / `Message` types.
 */

import * as crypto from "node:crypto";

import type { Conversation, Message, SourceIde } from "../../models/types.js";
import type { InterceptedExchange, ParsedChatExchange, AIProvider } from "../types.js";
import { parseOpenAIExchange } from "./openai-parser.js";
import { parseGoogleExchange } from "./google-parser.js";
import { parseAnthropicExchange } from "./anthropic-parser.js";

/** Provider → parser function mapping. */
const PARSERS: Record<AIProvider, (exchange: InterceptedExchange) => ParsedChatExchange | null> = {
  openai: parseOpenAIExchange,
  google: parseGoogleExchange,
  anthropic: parseAnthropicExchange,
};

/** Provider → SourceIde mapping. */
const PROVIDER_TO_SOURCE: Record<AIProvider, SourceIde> = {
  openai: "copilot",
  google: "antigravity",
  anthropic: "claude-code",
};

/**
 * Parse an intercepted HTTP exchange into a Conversation.
 *
 * @returns A `Conversation` with messages, or `null` if the exchange
 *          couldn't be parsed (e.g. non-chat endpoint, auth-only request).
 */
export function parseExchangeToConversation(
  exchange: InterceptedExchange,
): Conversation | null {
  const provider = exchange.request.endpoint.provider;
  const parser = PARSERS[provider];

  if (!parser) {
    return null;
  }

  const parsed = parser(exchange);
  if (!parsed) {
    return null;
  }

  // We need at least one user message to create a meaningful conversation
  const lastUserMsg = parsed.userMessages.filter((m) => m.role === "user").at(-1);
  if (!lastUserMsg) {
    return null;
  }

  const sourceIde = PROVIDER_TO_SOURCE[provider];
  const now = new Date().toISOString();

  // Generate a deterministic conversation ID from the exchange timestamp
  // and a hash of the user's last message. This means repeated identical
  // requests within the same second get the same ID (dedup).
  const conversationId = generateConversationId(
    sourceIde,
    lastUserMsg.content,
    exchange.request.timestamp,
  );

  // Build title from the user's last message (truncated)
  const title = truncate(lastUserMsg.content, 100);

  // Build the messages array
  const messages: Message[] = [];
  let msgIndex = 0;

  // Only include the last user message and the assistant response.
  // The full history is in the request body but it's from previous turns.
  messages.push({
    id: `${conversationId}-msg-${String(msgIndex++)}`,
    conversationId,
    role: "user",
    content: lastUserMsg.content,
    sourceModel: null,
    timestamp: new Date(exchange.request.timestamp).toISOString(),
    metadata: {
      capturedVia: "interceptor",
      endpoint: exchange.request.endpoint.label,
    },
  });

  if (parsed.assistantMessage) {
    messages.push({
      id: `${conversationId}-msg-${String(msgIndex++)}`,
      conversationId,
      role: "assistant",
      content: parsed.assistantMessage.content,
      sourceModel: parsed.model,
      timestamp: new Date(exchange.response.timestamp).toISOString(),
      metadata: {
        capturedVia: "interceptor",
        endpoint: exchange.request.endpoint.label,
        streaming: exchange.response.isStreaming,
      },
    });
  }

  return {
    id: conversationId,
    title,
    sourceIde,
    sourceHash: computeSourceHash(exchange),
    workspacePath: null,
    createdAt: now,
    updatedAt: now,
    messages,
  };
}

// ── Helpers ──

function generateConversationId(
  source: string,
  userMessage: string,
  timestamp: number,
): string {
  // Include the minute-level timestamp so conversations within the same
  // minute with the same text get deduped, but different minutes create new ones
  const minuteKey = Math.floor(timestamp / 60_000);
  const hash = crypto
    .createHash("sha256")
    .update(`${source}:${String(minuteKey)}:${userMessage}`)
    .digest("hex")
    .slice(0, 16);
  return `int-${hash}`;
}

function computeSourceHash(exchange: InterceptedExchange): string {
  return crypto
    .createHash("sha256")
    .update(exchange.request.body + exchange.response.body)
    .digest("hex")
    .slice(0, 32);
}

function truncate(text: string, maxLength: number): string {
  const clean = text.replace(/\n/g, " ").trim();
  if (clean.length <= maxLength) {
    return clean;
  }
  return clean.slice(0, maxLength - 3) + "...";
}
