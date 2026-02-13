/**
 * Monkey-patch for Node.js `http.request` / `https.request`.
 *
 * Wraps outgoing HTTP(S) requests to capture request and response bodies
 * for AI API endpoints. The original request is never modified or delayed.
 *
 * SAFETY: Every capture operation is wrapped in try/catch. An error in our
 * code must NEVER break the intercepted request.
 */

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
import * as http from "node:http";

import type * as vscode from "vscode";

// Use require() so we get a mutable CJS module object.
// ES `import * as` bindings are immutable in esbuild.
const httpMod = require("node:http") as typeof http;
const httpsMod = require("node:https") as typeof import("node:https");

import { matchEndpoint } from "./endpoint-registry.js";
import { BodyCollector, isSSEContentType } from "./stream-collector.js";
import type {
  AIEndpoint,
  InterceptedExchange,
  InterceptedRequest,
  InterceptedResponse,
} from "./types.js";

type RequestFn = typeof http.request;

/**
 * Install monkey-patches on http and https modules.
 *
 * @returns An object with an `unpatch()` method and an event emitter for
 *          captured exchanges.
 */
export function patchHttps(
  maxBodyBytes: number,
  log: vscode.OutputChannel,
  onExchange: (exchange: InterceptedExchange) => void,
): { unpatch: () => void } {
  const state = {
    origHttpRequest: httpMod.request,
    origHttpGet: httpMod.get,
    origHttpsRequest: httpsMod.request,
    origHttpsGet: httpsMod.get,
  };

  const wrapRequest = (
    original: RequestFn,
    moduleName: string,
  ): RequestFn => {
    // We need to return a function with the same overload signatures.
    // Using `function` to preserve `this` binding.
    const wrapped = function (
      this: unknown,
      ...args: unknown[]
    ): http.ClientRequest {
      // Call original first to preserve exact semantics
      const req = (original as Function).apply(this, args) as http.ClientRequest;

      try {
        // Extract URL info from the arguments
        const info = extractRequestInfo(args);
        if (!info) {
          return req;
        }

        const endpoint = matchEndpoint(info.hostname, info.path);
        if (!endpoint) {
          // DEBUG: Log all hostnames to find missing AI endpoints
          log.appendLine(`[interceptor] TRACE: Skipping ${moduleName} request: ${info.method} ${info.hostname}${info.path}`);
          return req;
        }

        log.appendLine(
          `[interceptor] ✅ Detected ${moduleName} request: ${info.method} ${info.hostname}${info.path} → ${endpoint.label}`,
        );

        instrumentRequest(req, endpoint, info, maxBodyBytes, log, onExchange);
      } catch (err) {
        // SAFETY: Never break the original request
        log.appendLine(
          `[interceptor] WARN: Failed to instrument request: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      return req;
    };

    return wrapped as unknown as RequestFn;
  };

  // Patch http
  httpMod.request = wrapRequest(state.origHttpRequest, "http");
  httpMod.get = function (this: unknown, ...args: unknown[]): http.ClientRequest {
    const req = (httpMod.request as Function).apply(this, args) as http.ClientRequest;
    req.end();
    return req;
  } as typeof httpMod.get;

  // Patch https
  httpsMod.request = wrapRequest(state.origHttpsRequest, "https");
  httpsMod.get = function (this: unknown, ...args: unknown[]): http.ClientRequest {
    const req = (httpsMod.request as Function).apply(this, args) as http.ClientRequest;
    req.end();
    return req;
  } as typeof httpsMod.get;

  log.appendLine("[interceptor] HTTP/HTTPS patches installed");

  return {
    unpatch: () => {
      httpMod.request = state.origHttpRequest;
      httpMod.get = state.origHttpGet;
      httpsMod.request = state.origHttpsRequest;
      httpsMod.get = state.origHttpsGet;
      log.appendLine("[interceptor] HTTP/HTTPS patches removed");
    },
  };
}

// ── Helpers ──

interface RequestInfo {
  hostname: string;
  path: string;
  method: string;
}

/**
 * Extract hostname, path, and method from the various `http.request()` call
 * signatures: (url, options, cb), (url, cb), (options, cb).
 */
function extractRequestInfo(args: readonly unknown[]): RequestInfo | null {
  for (const arg of args) {
    if (arg instanceof URL) {
      return {
        hostname: arg.hostname,
        path: arg.pathname + arg.search,
        method: "GET",
      };
    }

    if (typeof arg === "string") {
      try {
        const url = new URL(arg);
        return {
          hostname: url.hostname,
          path: url.pathname + url.search,
          method: "GET",
        };
      } catch {
        // not a full URL, skip
      }
    }

    if (typeof arg === "object" && arg !== null && !Buffer.isBuffer(arg)) {
      const opts = arg as Record<string, unknown>;
      const hostname =
        (opts["hostname"] as string | undefined) ??
        (opts["host"] as string | undefined);
      const path = (opts["path"] as string | undefined) ?? "/";
      const method = ((opts["method"] as string | undefined) ?? "GET").toUpperCase();

      if (hostname) {
        return { hostname, path, method };
      }
    }
  }

  return null;
}

/**
 * Attach capture instrumentation to an outgoing request.
 *
 * We monkey-patch `req.write()` and `req.end()` to capture the request body,
 * then listen on the `response` event to capture the response body.
 */
function instrumentRequest(
  req: http.ClientRequest,
  endpoint: AIEndpoint,
  info: RequestInfo,
  maxBodyBytes: number,
  log: vscode.OutputChannel,
  onExchange: (exchange: InterceptedExchange) => void,
): void {
  const requestBodyCollector = new BodyCollector(maxBodyBytes);
  const requestTimestamp = Date.now();

  // Capture request body via write() and end()
  const origWrite = req.write.bind(req);
  const origEnd = req.end.bind(req);

  req.write = function (
    chunk: unknown,
    ...rest: unknown[]
  ): boolean {
    try {
      if (chunk != null) {
        const buf =
          typeof chunk === "string" ? chunk : chunk instanceof Buffer ? chunk : Buffer.from(String(chunk));
        requestBodyCollector.push(buf);
      }
    } catch {
      // Safety: never break write
    }
    return (origWrite as Function).call(req, chunk, ...rest) as boolean;
  } as typeof req.write;

  req.end = function (
    chunk?: unknown,
    ...rest: unknown[]
  ): http.ClientRequest {
    try {
      if (chunk != null && typeof chunk !== "function") {
        const buf =
          typeof chunk === "string" ? chunk : chunk instanceof Buffer ? chunk : Buffer.from(String(chunk));
        requestBodyCollector.push(buf);
      }
    } catch {
      // Safety: never break end
    }
    return (origEnd as Function).call(req, chunk, ...rest) as http.ClientRequest;
  } as typeof req.end;

  // Capture response
  req.on("response", (res: http.IncomingMessage) => {
    try {
      const responseBodyCollector = new BodyCollector(maxBodyBytes);
      const contentType = res.headers["content-type"];
      const isStreaming = isSSEContentType(contentType);

      res.on("data", (chunk: Buffer | string) => {
        try {
          responseBodyCollector.push(
            typeof chunk === "string" ? chunk : chunk,
          );
        } catch {
          // Safety
        }
      });

      res.on("end", () => {
        try {
          const interceptedRequest: InterceptedRequest = {
            method: info.method,
            hostname: info.hostname,
            path: info.path,
            endpoint,
            body: requestBodyCollector.toString(),
            timestamp: requestTimestamp,
          };

          const interceptedResponse: InterceptedResponse = {
            statusCode: res.statusCode ?? 0,
            body: responseBodyCollector.toString(),
            isStreaming,
            timestamp: Date.now(),
          };

          const exchange: InterceptedExchange = {
            request: interceptedRequest,
            response: interceptedResponse,
          };

          log.appendLine(
            `[interceptor] Captured: ${info.method} ${endpoint.label} ` +
            `(req=${requestBodyCollector.size}b, res=${responseBodyCollector.size}b, ` +
            `streaming=${String(isStreaming)})`,
          );

          onExchange(exchange);
        } catch (err) {
          log.appendLine(
            `[interceptor] WARN: Failed to emit exchange: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      });

      res.on("error", (err: Error) => {
        log.appendLine(
          `[interceptor] WARN: Response error for ${endpoint.label}: ${err.message}`,
        );
      });
    } catch (err) {
      log.appendLine(
        `[interceptor] WARN: Failed to capture response: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });

  req.on("error", (err: Error) => {
    log.appendLine(
      `[interceptor] WARN: Request error for ${endpoint.label}: ${err.message}`,
    );
  });
}
