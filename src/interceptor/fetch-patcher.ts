/**
 * Monkey-patch for `globalThis.fetch`.
 *
 * Wraps the global fetch function to capture request and response bodies
 * for AI API endpoints. The original fetch call is never modified — we
 * clone the response to read it without consuming the original.
 *
 * SAFETY: Every capture operation is wrapped in try/catch.
 */

import type * as vscode from "vscode";

import { matchEndpoint } from "./endpoint-registry.js";
import { isSSEContentType } from "./stream-collector.js";
import type {
  InterceptedExchange,
  InterceptedRequest,
  InterceptedResponse,
} from "./types.js";

type FetchFn = typeof globalThis.fetch;

/**
 * Install a monkey-patch on `globalThis.fetch`.
 *
 * @returns An object with an `unpatch()` method.
 */
export function patchFetch(
  maxBodyBytes: number,
  log: vscode.OutputChannel,
  onExchange: (exchange: InterceptedExchange) => void,
): { unpatch: () => void } {
  const origFetch: FetchFn = globalThis.fetch;

  // Guard against double-patching
  if ((globalThis.fetch as unknown as Record<string, unknown>).__chatsync_patched) {
    log.appendLine("[interceptor] fetch already patched, skipping");
    return { unpatch: () => {} };
  }

  const patchedFetch: FetchFn = async function (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    // Parse the URL from the request
    let urlStr: string;
    try {
      if (typeof input === "string") {
        urlStr = input;
      } else if (input instanceof URL) {
        urlStr = input.toString();
      } else if (input instanceof Request) {
        urlStr = input.url;
      } else {
        // Unknown input type — pass through
        return origFetch(input, init);
      }
    } catch {
      return origFetch(input, init);
    }

    // Check if this is an AI endpoint
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(urlStr);
    } catch {
      return origFetch(input, init);
    }

    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const endpoint = matchEndpoint(parsedUrl.hostname, parsedUrl.pathname);
    if (!endpoint) {
      log.appendLine(`[interceptor] TRACE: Skipping fetch: ${method} ${parsedUrl.hostname}${parsedUrl.pathname}`);
      return origFetch(input, init);
    }

    const requestTimestamp = Date.now();

    log.appendLine(
      `[interceptor] ✅ Detected fetch request: ${method} ${parsedUrl.hostname}${parsedUrl.pathname} → ${endpoint.label}`,
    );

    // Capture request body
    let requestBody = "";
    try {
      if (init?.body) {
        if (typeof init.body === "string") {
          requestBody = init.body.slice(0, maxBodyBytes);
        } else if (init.body instanceof ArrayBuffer) {
          requestBody = new TextDecoder().decode(init.body.slice(0, maxBodyBytes));
        } else if (ArrayBuffer.isView(init.body)) {
          const view = init.body;
          const slice = new Uint8Array(view.buffer, view.byteOffset,
            Math.min(view.byteLength, maxBodyBytes),
          );
          requestBody = new TextDecoder().decode(slice);
        }
        // ReadableStream bodies are not captured to avoid consuming them
      } else if (input instanceof Request) {
        try {
          const clonedReq = input.clone();
          const body = await clonedReq.text();
          requestBody = body.slice(0, maxBodyBytes);
        } catch {
          // Can't read request body — that's OK
        }
      }
    } catch {
      // Safety: never break the request
    }

    // Call original fetch
    const response = await origFetch(input, init);

    // Clone the response to read the body without affecting the caller
    try {
      const clone = response.clone();
      const contentType = clone.headers.get("content-type") ?? undefined;
      const isStreaming = isSSEContentType(contentType);

      // Read the cloned response body
      let responseBody = "";
      try {
        const text = await clone.text();
        responseBody = text.slice(0, maxBodyBytes);
      } catch {
        // Body may already be consumed or unreadable
      }

      const interceptedRequest: InterceptedRequest = {
        method: method.toUpperCase(),
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        endpoint,
        body: requestBody,
        timestamp: requestTimestamp,
      };

      const interceptedResponse: InterceptedResponse = {
        statusCode: response.status,
        body: responseBody,
        isStreaming,
        timestamp: Date.now(),
      };

      const exchange: InterceptedExchange = {
        request: interceptedRequest,
        response: interceptedResponse,
      };

      log.appendLine(
        `[interceptor] Captured fetch: ${method} ${endpoint.label} ` +
        `(req=${requestBody.length}b, res=${responseBody.length}b, ` +
        `streaming=${String(isStreaming)})`,
      );

      onExchange(exchange);
    } catch (err) {
      log.appendLine(
        `[interceptor] WARN: Failed to capture fetch response: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Return the ORIGINAL response — caller is unaffected
    return response;
  };

  // Mark as patched to prevent double-patching
  (patchedFetch as any).__chatsync_patched = true;

  try {
    Object.defineProperty(globalThis, "fetch", {
      value: patchedFetch,
      configurable: true,
      writable: true,
    });
    log.appendLine("[interceptor] fetch patch installed via defineProperty");
  } catch (err) {
    // Fallback to direct assignment
    (globalThis as any).fetch = patchedFetch;
    log.appendLine("[interceptor] fetch patch installed via assignment");
  }

  return {
    unpatch: () => {
      try {
        Object.defineProperty(globalThis, "fetch", {
          value: origFetch,
          configurable: true,
          writable: true,
        });
      } catch {
        (globalThis as any).fetch = origFetch;
      }
      log.appendLine("[interceptor] fetch patch removed");
    },
  };
}
