/**
 * Parser for Google Gemini / Vertex AI API format.
 *
 * Handles Antigravity and direct Gemini API calls.
 *
 * Request format:
 *   { contents: [{ role: "user", parts: [{ text: "..." }] }] }
 *
 * Response format (non-streaming):
 *   { candidates: [{ content: { role: "model", parts: [{ text: "..." }] } }], modelVersion: "..." }
 *
 * Response format (streaming):
 *   Array of response objects (newline-delimited JSON or SSE)
 */

import { parseSSEEvents } from "../stream-collector.js";
import type {
  InterceptedExchange,
  ParsedChatExchange,
  ParsedMessage,
} from "../types.js";

interface GeminiPart {
  text?: string;
}

interface GeminiContent {
  role?: string;
  parts?: GeminiPart[];
}

interface GeminiRequest {
  contents?: GeminiContent[];
  model?: string;
}

interface GeminiCandidate {
  content?: GeminiContent;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  modelVersion?: string;
}

export function parseGoogleExchange(
  exchange: InterceptedExchange,
): ParsedChatExchange | null {
  // Parse request
  let request: GeminiRequest;
  try {
    request = JSON.parse(exchange.request.body) as GeminiRequest;
  } catch {
    return null;
  }

  if (!request.contents || !Array.isArray(request.contents)) {
    return null;
  }

  // Extract user messages
  const userMessages: ParsedMessage[] = [];
  for (const content of request.contents) {
    const role = normalizeGoogleRole(content.role);
    const text = extractPartsText(content.parts);
    if (role && text) {
      userMessages.push({ role, content: text });
    }
  }

  if (userMessages.length === 0) {
    return null;
  }

  // Extract model name from URL path (e.g. /v1beta/models/gemini-1.5-pro:generateContent)
  let model: string | null = request.model ?? extractModelFromPath(exchange.request.path);

  // Parse response
  let assistantContent = "";

  if (exchange.response.isStreaming) {
    // Streaming: could be SSE or newline-delimited JSON array
    const events = parseSSEEvents(exchange.response.body);
    if (events.length > 0) {
      // SSE format
      for (const event of events) {
        const resp = event as GeminiResponse;
        assistantContent += extractCandidateText(resp);
        if (resp.modelVersion) {
          model = resp.modelVersion;
        }
      }
    } else {
      // Try as JSON array (Google sometimes wraps streaming in [])
      try {
        const parsed = JSON.parse(exchange.response.body) as unknown;
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            const resp = item as GeminiResponse;
            assistantContent += extractCandidateText(resp);
            if (resp.modelVersion) {
              model = resp.modelVersion;
            }
          }
        }
      } catch {
        // Not parseable
      }
    }
  } else {
    // Non-streaming
    try {
      const body = exchange.response.body.trim();
      // Google can return a JSON array even for non-streaming
      const parsed = JSON.parse(body) as unknown;

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const resp = item as GeminiResponse;
          assistantContent += extractCandidateText(resp);
          if (resp.modelVersion) {
            model = resp.modelVersion;
          }
        }
      } else {
        const resp = parsed as GeminiResponse;
        assistantContent = extractCandidateText(resp);
        if (resp.modelVersion) {
          model = resp.modelVersion;
        }
      }
    } catch {
      // Unparseable response
    }
  }

  const assistantMessage: ParsedMessage | null = assistantContent
    ? { role: "assistant", content: assistantContent }
    : null;

  return {
    provider: "google",
    model,
    userMessages,
    assistantMessage,
  };
}

// ── Helpers ──

function normalizeGoogleRole(role: string | undefined): ParsedMessage["role"] | null {
  switch (role?.toLowerCase()) {
    case "user":
      return "user";
    case "model":
      return "assistant";
    case "system":
      return "system";
    default:
      return null;
  }
}

function extractPartsText(parts: GeminiPart[] | undefined): string {
  if (!parts) {
    return "";
  }
  return parts
    .filter((p) => p.text != null)
    .map((p) => p.text!)
    .join("");
}

function extractCandidateText(resp: GeminiResponse): string {
  if (!resp.candidates) {
    return "";
  }
  return resp.candidates
    .map((c) => extractPartsText(c.content?.parts))
    .join("");
}

function extractModelFromPath(path: string): string | null {
  // Path: /v1beta/models/gemini-1.5-pro:generateContent
  const match = /\/models\/([^/:]+)/.exec(path);
  return match?.[1] ?? null;
}
