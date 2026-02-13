/**
 * Registry of known AI API endpoints.
 *
 * Maps hostnames + path prefixes to AI providers so the interceptor
 * knows which outgoing requests to capture.
 */

import type { AIEndpoint } from "./types.js";

/**
 * All known AI API endpoints.
 * Order does not matter — lookup is by hostname first, then path prefix.
 */
const ENDPOINTS: readonly AIEndpoint[] = [
  // ── OpenAI / Copilot ──
  {
    provider: "openai",
    hostname: "api.openai.com",
    pathPrefix: "/v1/chat/completions",
    label: "OpenAI Chat",
  },
  {
    provider: "openai",
    hostname: "api.githubcopilot.com",
    pathPrefix: "/chat/completions",
    label: "GitHub Copilot",
  },
  // Copilot can also proxy through this hostname
  {
    provider: "openai",
    hostname: "copilot-proxy.githubusercontent.com",
    pathPrefix: "/v1/chat/completions",
    label: "Copilot Proxy",
  },

  // ── Google / Gemini / Antigravity ──
  {
    provider: "google",
    hostname: "generativelanguage.googleapis.com",
    pathPrefix: "/", // Match all paths for this host
    label: "Gemini",
  },
  {
    provider: "google",
    hostname: "us-central1-aiplatform.googleapis.com",
    pathPrefix: "/v1/projects/",
    label: "Vertex AI",
  },
  {
    provider: "google",
    hostname: "autopush-generativelanguage.googleapis.com", // Internal/Dev variants
    pathPrefix: "/",
    label: "Gemini (Autopush)",
  },

  // ── Anthropic / Claude ──
  {
    provider: "anthropic",
    hostname: "api.anthropic.com",
    pathPrefix: "/v1/messages",
    label: "Anthropic Messages",
  },
];

/**
 * Index by hostname for O(1) lookup of the most common case (non-AI traffic).
 */
const byHostname = new Map<string, AIEndpoint[]>();
for (const ep of ENDPOINTS) {
  const list = byHostname.get(ep.hostname) ?? [];
  list.push(ep);
  byHostname.set(ep.hostname, list);
}

/**
 * Match an outgoing request against known AI endpoints.
 *
 * @returns The matched endpoint, or `null` if not an AI API call.
 */
export function matchEndpoint(
  hostname: string | undefined,
  path: string | undefined,
): AIEndpoint | null {
  if (!hostname || !path) {
    return null;
  }

  const candidates = byHostname.get(hostname);
  if (!candidates) {
    return null;
  }

  for (const ep of candidates) {
    if (path.startsWith(ep.pathPrefix)) {
      return ep;
    }
  }

  return null;
}
