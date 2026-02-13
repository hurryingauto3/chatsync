/**
 * Server-Sent Events (SSE) stream collector.
 *
 * Reassembles chunked SSE responses (used by OpenAI, Google, and Anthropic
 * streaming APIs) into a single complete body string.
 */

/**
 * Collect all `data:` payloads from an SSE text stream.
 *
 * @param raw  The full SSE text (all chunks concatenated).
 * @returns    Array of parsed JSON objects from each `data:` line,
 *             excluding the `[DONE]` sentinel.
 */
export function parseSSEEvents(raw: string): readonly unknown[] {
  const results: unknown[] = [];

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();

    if (!trimmed.startsWith("data:")) {
      continue;
    }

    const payload = trimmed.slice(5).trim();

    // OpenAI / Anthropic use [DONE] to signal end of stream
    if (payload === "[DONE]") {
      continue;
    }

    try {
      results.push(JSON.parse(payload) as unknown);
    } catch {
      // Non-JSON data line — skip
    }
  }

  return results;
}

/**
 * Detect whether a response is likely SSE based on content-type header.
 */
export function isSSEContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }
  return (
    contentType.includes("text/event-stream") ||
    contentType.includes("text/x-sse")
  );
}

/**
 * Incrementally collect chunks of an HTTP response body.
 *
 * Enforces a maximum buffer size to prevent memory exhaustion from
 * very large responses.
 */
export class BodyCollector {
  private readonly chunks: Buffer[] = [];
  private totalBytes = 0;
  private truncated = false;

  constructor(private readonly maxBytes: number) {}

  /** Append a chunk. Returns false if the buffer is full. */
  push(chunk: Buffer | string): boolean {
    if (this.truncated) {
      return false;
    }

    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;

    if (this.totalBytes + buf.length > this.maxBytes) {
      // Take what fits, then mark truncated
      const remaining = this.maxBytes - this.totalBytes;
      if (remaining > 0) {
        this.chunks.push(buf.subarray(0, remaining));
        this.totalBytes = this.maxBytes;
      }
      this.truncated = true;
      return false;
    }

    this.chunks.push(buf);
    this.totalBytes += buf.length;
    return true;
  }

  /** Get the collected body as a UTF-8 string. */
  toString(): string {
    return Buffer.concat(this.chunks).toString("utf-8");
  }

  /** Whether the body was truncated due to size limits. */
  get isTruncated(): boolean {
    return this.truncated;
  }

  /** Total bytes collected. */
  get size(): number {
    return this.totalBytes;
  }
}
