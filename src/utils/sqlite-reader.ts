import initSqlJs, { type Database as SqlJsDatabase, type SqlJsStatic, type SqlValue } from "sql.js";
import * as fs from "node:fs";

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    sqlJsPromise = initSqlJs();
  }
  return sqlJsPromise;
}

/**
 * Safe SQLite reader utility using sql.js (pure JS, no native deps).
 * Opens databases in read-only mode to avoid corruption of IDE state files.
 */
export class SqliteReader {
  private db: SqlJsDatabase | null = null;

  constructor(private readonly dbPath: string) {}

  async open(): Promise<void> {
    const SQL = await getSqlJs();
    const buffer = fs.readFileSync(this.dbPath);
    this.db = new SQL.Database(buffer);
  }

  close(): void {
    this.db?.close();
    this.db = null;
  }

  /**
   * Get a single value from a key-value style table.
   */
  getKeyValue(table: string, key: string): string | null {
    this.ensureOpen();
    const stmt = this.db!.prepare(`SELECT value FROM "${table}" WHERE key = ?`);
    stmt.bind([key]);
    if (stmt.step()) {
      const row = stmt.get();
      stmt.free();
      return row[0] as string | null;
    }
    stmt.free();
    return null;
  }

  /**
   * Query rows from a table. Returns array of objects.
   */
  query<T>(sql: string, params?: readonly SqlValue[]): readonly T[] {
    this.ensureOpen();
    const results: T[] = [];
    const stmt = this.db!.prepare(sql);
    if (params) {
      stmt.bind([...params]);
    }
    while (stmt.step()) {
      const columns = stmt.getColumnNames();
      const values = stmt.get();
      const row: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i++) {
        row[columns[i]!] = values[i];
      }
      results.push(row as T);
    }
    stmt.free();
    return results;
  }

  /**
   * Check if a table exists.
   */
  tableExists(tableName: string): boolean {
    this.ensureOpen();
    const stmt = this.db!.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
    );
    stmt.bind([tableName]);
    const exists = stmt.step();
    stmt.free();
    return exists;
  }

  private ensureOpen(): void {
    if (!this.db) {
      throw new Error(`Database not open: ${this.dbPath}`);
    }
  }
}

/**
 * Run a read-only operation on a SQLite database, ensuring it's properly closed.
 */
export async function withSqliteReader<T>(
  dbPath: string,
  fn: (reader: SqliteReader) => T,
): Promise<T> {
  const reader = new SqliteReader(dbPath);
  try {
    await reader.open();
    return fn(reader);
  } finally {
    reader.close();
  }
}
