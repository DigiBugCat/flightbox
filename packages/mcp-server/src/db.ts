import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection } from "@duckdb/node-api";
import { join } from "node:path";
import { homedir } from "node:os";

let instance: DuckDBInstance | null = null;
let connection: DuckDBConnection | null = null;

export function getTracesDir(): string {
  return (
    process.env.FLIGHTBOX_TRACES_DIR ??
    join(homedir(), ".flightbox", "traces")
  );
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
  const conn = await getConnection();
  const reader = await conn.runAndReadAll(sql);
  return reader.getRowObjects() as Record<string, unknown>[];
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
