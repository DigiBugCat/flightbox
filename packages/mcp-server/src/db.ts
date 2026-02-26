import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection } from "@duckdb/node-api";
import { join } from "node:path";
import { homedir } from "node:os";
import { readdirSync, statSync, unlinkSync } from "node:fs";

let instance: DuckDBInstance | null = null;
let connection: DuckDBConnection | null = null;

export function getTracesDir(): string {
  return (
    process.env.FLIGHTBOX_TRACES_DIR ??
    join(homedir(), ".flightbox", "traces")
  );
}

/**
 * Remove empty (0-byte) parquet files that would break read_parquet glob.
 * Runs lazily — cheap to call often since it's a single readdir + stat.
 */
export function cleanEmptyParquetFiles(): number {
  const dir = getTracesDir();
  let removed = 0;
  try {
    const files = readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith(".parquet")) continue;
      const filepath = join(dir, f);
      try {
        const st = statSync(filepath);
        if (st.size === 0) {
          unlinkSync(filepath);
          removed++;
        }
      } catch {
        // File may have been deleted between readdir and stat
      }
    }
  } catch {
    // Traces dir may not exist yet
  }
  return removed;
}

export async function getConnection(): Promise<DuckDBConnection> {
  if (connection) return connection;

  instance = await DuckDBInstance.create(":memory:");
  connection = await instance.connect();

  return connection;
}

export async function query(
  sql: string,
): Promise<Record<string, unknown>[]> {
  // Clean up any 0-byte files before querying
  cleanEmptyParquetFiles();

  const conn = await getConnection();
  const reader = await conn.runAndReadAll(sql);
  const rows = reader.getRowObjects() as Record<string, unknown>[];
  // Convert BigInt values to numbers (DuckDB returns BIGINT as BigInt)
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) {
      out[k] = typeof v === "bigint" ? Number(v) : v;
    }
    return out;
  });
}

function parquetGlob(): string {
  return `'${getTracesDir()}/*.parquet'`;
}

export function fromSpans(where?: string, orderBy?: string): string {
  let sql = `SELECT * FROM read_parquet(${parquetGlob()}, union_by_name=true)`;
  if (where) sql += ` WHERE ${where}`;
  if (orderBy) sql += ` ORDER BY ${orderBy}`;
  return sql;
}

export function countSpans(where?: string): string {
  let sql = `SELECT count(*) as cnt FROM read_parquet(${parquetGlob()}, union_by_name=true)`;
  if (where) sql += ` WHERE ${where}`;
  return sql;
}
