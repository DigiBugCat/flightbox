import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection } from "@duckdb/node-api";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { readdirSync, statSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

let instance: DuckDBInstance | null = null;
let connection: DuckDBConnection | null = null;

/**
 * Resolve the traces directory. Priority:
 * 1. FLIGHTBOX_TRACES_DIR env var (explicit override)
 * 2. Per-project dir: ~/.flightbox/traces/{cwd basename}/
 */
export function getTracesDir(): string {
  if (process.env.FLIGHTBOX_TRACES_DIR) {
    return process.env.FLIGHTBOX_TRACES_DIR;
  }
  return join(homedir(), ".flightbox", "traces", detectProjectRoot());
}

/**
 * Find the project root (git root or cwd) and encode the full path
 * as a nested directory structure under ~/.flightbox/traces/.
 * /Users/andrew/dev/pantainos-world → Users/andrew/dev/pantainos-world
 * This ensures monorepo subpackages all share one traces dir,
 * and projects with the same name in different locations don't collide.
 */
function detectProjectRoot(): string {
  let root: string;
  try {
    root = execSync("git rev-parse --show-toplevel", {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    root = process.cwd();
  }
  // Strip leading slash to create a relative nested path
  return root.replace(/^\//, "");
}

const DEFAULT_RETENTION_HOURS = 24;

/**
 * Remove empty (0-byte) parquet files and files older than retention period.
 * Runs lazily — cheap to call often since it's a single readdir + stat.
 */
export function cleanParquetFiles(): number {
  const dir = getTracesDir();
  const retentionMs = (Number(process.env.FLIGHTBOX_RETENTION_HOURS) || DEFAULT_RETENTION_HOURS) * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;
  let removed = 0;
  try {
    const files = readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith(".parquet")) continue;
      const filepath = join(dir, f);
      try {
        const st = statSync(filepath);
        if (st.size === 0 || st.mtimeMs < cutoff) {
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
  cleanParquetFiles();

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

/** Returns the parquet table expression for use in raw SQL (no SELECT, no WHERE). */
export function fromSpansInline(): string {
  return `read_parquet(${parquetGlob()}, union_by_name=true)`;
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

export function callEdgesViewSql(where?: string): string {
  const clauses = [
    `parent_id IS NOT NULL`,
    `parent_id != ''`,
  ];
  if (where) clauses.push(where);
  return `
SELECT
  'span' AS from_node_type,
  parent_id AS from_node_id,
  'span' AS to_node_type,
  span_id AS to_node_id,
  'call' AS edge_kind,
  'exact' AS evidence_kind,
  1.0 AS confidence,
  trace_id,
  started_at AS event_at
FROM read_parquet(${parquetGlob()}, union_by_name=true)
WHERE ${clauses.join(" AND ")}
`;
}

export function lineageEdgesViewSql(where?: string): string {
  const clauses = [
    `spans.tags_json IS NOT NULL`,
  ];
  if (where) clauses.push(where);
  return `
SELECT
  'span' AS from_node_type,
  CAST(json_extract_string(json_each.value, '$.span_id') AS VARCHAR) AS from_node_id,
  'span' AS to_node_type,
  span_id AS to_node_id,
  'lineage' AS edge_kind,
  COALESCE(CAST(json_extract_string(json_each.value, '$.evidence_kind') AS VARCHAR), 'exact') AS evidence_kind,
  CASE
    WHEN COALESCE(CAST(json_extract_string(json_each.value, '$.evidence_kind') AS VARCHAR), 'exact') = 'exact' THEN 1.0
    WHEN COALESCE(CAST(json_extract_string(json_each.value, '$.evidence_kind') AS VARCHAR), 'exact') = 'inferred' THEN 0.5
    ELSE 0.0
  END AS confidence,
  spans.trace_id,
  spans.started_at AS event_at
FROM (
  SELECT
    *,
    TRY_CAST(tags AS JSON) AS tags_json
  FROM read_parquet(${parquetGlob()}, union_by_name=true)
) AS spans,
LATERAL json_each(COALESCE(json_extract(spans.tags_json, '$.lineage_recv'), '[]'))
WHERE ${clauses.join(" AND ")}
AND CAST(json_extract_string(json_each.value, '$.span_id') AS VARCHAR) IS NOT NULL
AND CAST(json_extract_string(json_each.value, '$.span_id') AS VARCHAR) != ''
`;
}

export function objectEventsViewSql(where?: string): string {
  const clauses = [
    `spans.tags_json IS NOT NULL`,
  ];
  if (where) clauses.push(where);
  return `
SELECT
  spans.span_id,
  spans.trace_id,
  spans.started_at AS event_at,
  CAST(json_extract_string(json_each.value, '$.action') AS VARCHAR) AS action,
  CAST(json_extract_string(json_each.value, '$.object_type') AS VARCHAR) AS object_type,
  CAST(json_extract_string(json_each.value, '$.object_id') AS VARCHAR) AS object_id,
  CAST(json_extract_string(json_each.value, '$.snapshot') AS VARCHAR) AS snapshot,
  CAST(json_extract_string(json_each.value, '$.changes') AS VARCHAR) AS changes,
  CAST(json_extract_string(json_each.value, '$.note') AS VARCHAR) AS note,
  CAST(json_extract(json_each.value, '$.dimensions') AS VARCHAR) AS dimensions_json
FROM (
  SELECT
    *,
    TRY_CAST(tags AS JSON) AS tags_json
  FROM read_parquet(${parquetGlob()}, union_by_name=true)
) AS spans,
LATERAL json_each(COALESCE(json_extract(spans.tags_json, '$.objects'), '[]'))
WHERE ${clauses.join(" AND ")}
AND CAST(json_extract_string(json_each.value, '$.action') AS VARCHAR) IS NOT NULL
AND CAST(json_extract_string(json_each.value, '$.object_type') AS VARCHAR) IS NOT NULL
`;
}

export function causalEdgesViewSql(where?: string): string {
  return `
SELECT * FROM (
${callEdgesViewSql(where)}
) AS call_edges
UNION ALL
SELECT * FROM (
${lineageEdgesViewSql(where)}
) AS lineage_edges
`;
}

interface FlightboxManifest {
  declared_object_types?: unknown;
}

export function getConfiguredObjectTypes(): string[] {
  const envRaw = process.env.FLIGHTBOX_OBJECT_TYPES;
  if (envRaw) {
    const parsed = parseObjectTypes(envRaw);
    if (parsed.length > 0) return parsed;
  }

  const manifestPath = join(process.cwd(), ".flightbox", "manifest.json");
  if (!existsSync(manifestPath)) return [];

  try {
    const raw = readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as FlightboxManifest;
    return normalizeObjectTypes(parsed.declared_object_types);
  } catch {
    return [];
  }
}

function parseObjectTypes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return normalizeObjectTypes(parsed);
  } catch {
    return normalizeObjectTypes(raw.split(","));
  }
}

function normalizeObjectTypes(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return [...new Set(
    input
      .map((value) => (typeof value === "string" ? value.trim() : ""))
      .filter((value) => value.length > 0),
  )];
}
