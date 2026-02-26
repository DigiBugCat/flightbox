import { DuckDBInstance } from "@duckdb/node-api";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Span } from "@flightbox/core";

const SCHEMA_SQL = `
CREATE TABLE spans (
  span_id VARCHAR,
  trace_id VARCHAR,
  parent_id VARCHAR,
  kind VARCHAR,
  name VARCHAR,
  module VARCHAR,
  file_line VARCHAR,
  input VARCHAR,
  output VARCHAR,
  error VARCHAR,
  context VARCHAR,
  started_at BIGINT,
  ended_at BIGINT,
  duration_ms DOUBLE,
  git_sha VARCHAR,
  tags VARCHAR
)`;

export async function flushToParquet(
  spans: Span[],
  tracesDir: string,
): Promise<void> {
  if (spans.length === 0) return;

  mkdirSync(tracesDir, { recursive: true });

  const filename = `${Date.now()}-${process.pid}-${counter()}.parquet`;
  const filepath = join(tracesDir, filename);

  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();

  await conn.run(SCHEMA_SQL);

  // Use appender for efficient bulk insertion
  const appender = await conn.createAppender("spans");

  for (const s of spans) {
    appender.appendVarchar(s.span_id);
    appender.appendVarchar(s.trace_id);
    appender.appendVarchar(s.parent_id ?? "");
    appender.appendVarchar(s.kind);
    appender.appendVarchar(s.name);
    appender.appendVarchar(s.module);
    appender.appendVarchar(s.file_line);
    appender.appendVarchar(s.input ?? "");
    appender.appendVarchar(s.output ?? "");
    appender.appendVarchar(s.error ?? "");
    appender.appendVarchar(s.context ?? "");
    appender.appendBigInt(BigInt(s.started_at));
    appender.appendBigInt(BigInt(s.ended_at ?? 0));
    appender.appendDouble(s.duration_ms ?? 0);
    appender.appendVarchar(s.git_sha ?? "");
    appender.appendVarchar(s.tags ?? "");
    appender.endRow();
  }

  appender.flushSync();
  appender.closeSync();

  await conn.run(
    `COPY spans TO '${filepath.replace(/'/g, "''")}' (FORMAT PARQUET)`,
  );
}

let _counter = 0;
function counter(): number {
  return _counter++;
}
