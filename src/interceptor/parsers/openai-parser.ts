/**
 * Parser for OpenAI Chat Completions API format.
 *
 * Handles both Copilot (via api.githubcopilot.com or api.openai.com)
 * and direct OpenAI API calls.
 *
 * Request format:
 *   { model: "gpt-4o", messages: [{ role, content }], stream: true/false }
 *
 * Response format (non-streaming):
 *   { choices: [{ message: { role, content } }], model: "..." }
 *
 * Response format (streaming SSE):
 *   data: { choices: [{ delta: { role?, content? } }], model: "..." }
 */

import { parseSSEEvents } from "../stream-collector.js";
import type {
  InterceptedExchange,
  ParsedChatExchange,
  ParsedMessage,
} from "../types.js";

interface OpenAIMessage {
  role?: string;
  content?: string | null;
}

interface OpenAIRequest {
  model?: string;
  messages?: OpenAIMessage[];
  stream?: boolean;
}

interface OpenAIChoice {
  message?: OpenAIMessage;
  delta?: OpenAIMessage;
}

interface OpenAIResponse {
  choices?: OpenAIChoice[];
  model?: string;
}

export function parseOpenAIExchange(
  exchange: InterceptedExchange,
): ParsedChatExchange | null {
  // Parse request
  let request: OpenAIRequest;
  try {
    request = JSON.parse(exchange.request.body) as OpenAIRequest;
  } catch {
    return null;
  }

  if (!request.messages || !Array.isArray(request.messages)) {
    return null;
  }

  // Extract user messages from the request
  const userMessages: ParsedMessage[] = [];
  for (const msg of request.messages) {
    if (msg.role && msg.content) {
      const role = normalizeRole(msg.role);
      if (role) {
        userMessages.push({ role, content: msg.content });
      }
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
      const resp = event as OpenAIResponse;
      if (resp.model) {
        model = resp.model;
      }
      if (resp.choices) {
        for (const choice of resp.choices) {
          if (choice.delta?.content) {
            assistantContent += choice.delta.content;
          }
        }
      }
    }
  } else {
    // Non-streaming JSON response
    try {
      const resp = JSON.parse(exchange.response.body) as OpenAIResponse;
      if (resp.model) {
        model = resp.model;
      }
      if (resp.choices?.[0]?.message?.content) {
        assistantContent = resp.choices[0].message.content;
      }
    } catch {
      // Unparseable response
    }
  }

  const assistantMessage: ParsedMessage | null = assistantContent
    ? { role: "assistant", content: assistantContent }
    : null;

  return {
    provider: "openai",
    model,
    userMessages,
    assistantMessage,
  };
}

function normalizeRole(role: string): ParsedMessage["role"] | null {
  switch (role.toLowerCase()) {
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
