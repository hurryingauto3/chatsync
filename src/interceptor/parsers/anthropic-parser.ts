/**
 * Parser for Anthropic Messages API format.
 *
 * Request format:
 *   { model: "claude-...", messages: [{ role, content }], stream: true/false }
 *
 * Response format (non-streaming):
 *   { content: [{ type: "text", text: "..." }], model: "...", role: "assistant" }
 *
 * Response format (streaming SSE):
 *   event: content_block_delta
 *   data: { type: "content_block_delta", delta: { type: "text_delta", text: "..." } }
 */

import { parseSSEEvents } from "../stream-collector.js";
import type {
  InterceptedExchange,
  ParsedChatExchange,
  ParsedMessage,
} from "../types.js";

interface AnthropicMessage {
  role?: string;
  content?: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type?: string;
  text?: string;
}

interface AnthropicRequest {
  model?: string;
  messages?: AnthropicMessage[];
  system?: string;
  stream?: boolean;
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  model?: string;
  role?: string;
}

interface AnthropicStreamEvent {
  type?: string;
  delta?: {
    type?: string;
    text?: string;
  };
  content_block?: AnthropicContentBlock;
  message?: AnthropicResponse;
}

export function parseAnthropicExchange(
  exchange: InterceptedExchange,
): ParsedChatExchange | null {
  // Parse request
  let request: AnthropicRequest;
  try {
    request = JSON.parse(exchange.request.body) as AnthropicRequest;
  } catch {
    return null;
  }

  if (!request.messages || !Array.isArray(request.messages)) {
    return null;
  }

  // Extract user messages
  const userMessages: ParsedMessage[] = [];

  // System message if present
  if (request.system) {
    userMessages.push({ role: "system", content: request.system });
  }

  for (const msg of request.messages) {
    const role = normalizeRole(msg.role);
    const content = extractMessageContent(msg);
    if (role && content) {
      userMessages.push({ role, content });
    }
  }

  if (userMessages.length === 0) {
    return null;
  }

  // Parse response
  let assistantContent = "";
  let model = request.model ?? null;

  if (exchange.response.isStreaming || request.stream) {
    // SSE streaming response
    const events = parseSSEEvents(exchange.response.body);
    for (const event of events) {
      const streamEvent = event as AnthropicStreamEvent;

      // Extract model from message_start event
      if (streamEvent.type === "message_start" && streamEvent.message?.model) {
        model = streamEvent.message.model;
      }

      // Extract text from content_block_delta events
      if (
        streamEvent.type === "content_block_delta" &&
        streamEvent.delta?.type === "text_delta" &&
        streamEvent.delta.text
      ) {
        assistantContent += streamEvent.delta.text;
      }

      // Some implementations send complete blocks
      if (
        streamEvent.type === "content_block_start" &&
        streamEvent.content_block?.text
      ) {
        assistantContent += streamEvent.content_block.text;
      }
    }
  } else {
    // Non-streaming JSON response
    try {
      const resp = JSON.parse(exchange.response.body) as AnthropicResponse;
      if (resp.model) {
        model = resp.model;
      }
      if (resp.content) {
        assistantContent = resp.content
          .filter((block) => block.type === "text" && block.text)
          .map((block) => block.text!)
          .join("");
      }
    } catch {
      // Unparseable response
    }
  }

  const assistantMessage: ParsedMessage | null = assistantContent
    ? { role: "assistant", content: assistantContent }
    : null;

  return {
    provider: "anthropic",
    model,
    userMessages,
    assistantMessage,
  };
}

// ── Helpers ──

function normalizeRole(role: string | undefined): ParsedMessage["role"] | null {
  switch (role?.toLowerCase()) {
    case "user":
      return "user";
    case "assistant":
      return "assistant";
    case "system":
      return "system";
    default:
      return null;
  }
}

function extractMessageContent(msg: AnthropicMessage): string | null {
  if (typeof msg.content === "string") {
    return msg.content;
  }

  if (Array.isArray(msg.content)) {
    const text = msg.content
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text!)
      .join("");
    return text || null;
  }

  return null;
}
