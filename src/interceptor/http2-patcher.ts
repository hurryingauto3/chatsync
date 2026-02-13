/**
 * Monkey-patch for Node.js `http2`.
 */

import type * as vscode from "vscode";
import { matchEndpoint } from "./endpoint-registry.js";
import { BodyCollector } from "./stream-collector.js";
import type {
  AIEndpoint,
  InterceptedExchange,
} from "./types.js";

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
let http2Mod: any;
try {
  http2Mod = require("node:http2");
} catch {
  // http2 might not be available in all envs
}

export function patchHttp2(
  maxBodyBytes: number,
  log: vscode.OutputChannel,
  onExchange: (exchange: InterceptedExchange) => void,
): { unpatch: () => void } {
  if (!http2Mod) {
    return { unpatch: () => {} };
  }

  const origConnect = http2Mod.connect;

  http2Mod.connect = function(authority: string, options: any, listener: any) {
    const client = origConnect.call(this, authority, options, listener);
    
    // Patch the request method on the client session
    const origRequest = client.request;
    client.request = function(headers: any, options: any) {
      const stream = origRequest.call(this, headers, options);
      
      try {
        const url = new URL(authority);
        const path = headers[":path"] || "/";
        const method = headers[":method"] || "POST";
        const endpoint = matchEndpoint(url.hostname, path);

        if (endpoint) {
          log.appendLine(`[interceptor] ✅ Detected HTTP2 stream: ${method} ${url.hostname}${path} → ${endpoint.label}`);
          instrumentHttp2Stream(stream, endpoint, url.hostname, path, method, maxBodyBytes, log, onExchange);
        } else {
          log.appendLine(`[interceptor] TRACE: Skipping HTTP2 stream: ${method} ${url.hostname}${path}`);
        }
      } catch (err) {
        // Safety
      }

      return stream;
    };

    return client;
  };

  log.appendLine("[interceptor] HTTP2 patches installed");

  return {
    unpatch: () => {
      http2Mod.connect = origConnect;
      log.appendLine("[interceptor] HTTP2 patches removed");
    },
  };
}

function instrumentHttp2Stream(
  stream: any,
  endpoint: AIEndpoint,
  hostname: string,
  path: string,
  method: string,
  maxBodyBytes: number,
  log: vscode.OutputChannel,
  onExchange: (exchange: InterceptedExchange) => void,
): void {
  const requestBodyCollector = new BodyCollector(maxBodyBytes);
  const responseBodyCollector = new BodyCollector(maxBodyBytes);
  const requestTimestamp = Date.now();

  // Capture request data
  const origWrite = stream.write;
  const origEnd = stream.end;

  stream.write = function(chunk: any, ...args: any[]) {
    try {
      if (chunk) requestBodyCollector.push(chunk);
    } catch {}
    return origWrite.apply(this, [chunk, ...args]);
  };

  stream.end = function(chunk: any, ...args: any[]) {
    try {
      if (chunk && typeof chunk !== "function") requestBodyCollector.push(chunk);
    } catch {}
    return origEnd.apply(this, [chunk, ...args]);
  };

  // Capture response data
  let statusCode = 0;
  stream.on("response", (headers: any) => {
    statusCode = headers[":status"] || 0;
  });

  stream.on("data", (chunk: any) => {
    try {
      responseBodyCollector.push(chunk);
    } catch {}
  });

  stream.on("end", () => {
    try {
      const exchange: InterceptedExchange = {
        request: {
          method,
          hostname,
          path,
          endpoint,
          body: requestBodyCollector.toString(),
          timestamp: requestTimestamp,
        },
        response: {
          statusCode,
          body: responseBodyCollector.toString(),
          isStreaming: true, // HTTP2 streams are typically used for streaming
          timestamp: Date.now(),
        },
      };
      onExchange(exchange);
    } catch (err) {
      log.appendLine(`[interceptor] WARN: Failed to emit HTTP2 exchange: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}
