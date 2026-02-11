import initSqlJs, { type SqlJsStatic } from "sql.js";
import * as fs from "node:fs";
import * as path from "node:path";

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

/**
 * Get a shared, lazily-initialized sql.js instance.
 * Loads the WASM binary from the extension's dist/ directory.
 */
export function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = loadSqlJs();
  }
  return sqlJsPromise;
}

async function loadSqlJs(): Promise<SqlJsStatic> {
  // __dirname is the dist/ directory when bundled with esbuild
  const wasmPath = path.join(__dirname, "sql-wasm.wasm");

  if (fs.existsSync(wasmPath)) {
    const buf = fs.readFileSync(wasmPath);
    const wasmBinary = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return initSqlJs({ wasmBinary });
  }

  // Fallback: let sql.js try to find it on its own
  return initSqlJs();
}
