import { z } from "zod";
import { query, fromSpans, countSpans, getTracesDir } from "./db.js";

// Helper to escape SQL string values
function esc(s: string): string {
  return s.replace(/'/g, "''");
}

function timeFilter(minutes?: number): string {
  if (!minutes) return "";
  return `started_at >= ${Date.now() - minutes * 60 * 1000}`;
}

function and(...clauses: (string | undefined | "")[]): string {
  return clauses.filter(Boolean).join(" AND ");
}

// ─── Tool Schemas ───

export const summarySchema = z.object({
  trace_id: z.string().optional(),
  last_n_minutes: z.number().optional(),
});

export const childrenSchema = z.object({
  span_id: z.string(),
  depth: z.number().default(1),
  include_args: z.boolean().default(false),
});

export const inspectSchema = z.object({
  span_id: z.string(),
});

export const walkSchema = z.object({
  span_id: z.string(),
  direction: z.enum(["up", "down", "both"]).default("both"),
  depth: z.number().default(5),
});

export const searchSchema = z.object({
  text: z.string().optional(),
  name_pattern: z.string().optional(),
  has_error: z.boolean().optional(),
  min_duration_ms: z.number().optional(),
  ancestor_of: z.string().optional(),
  descendant_of: z.string().optional(),
  trace_id: z.string().optional(),
  last_n_minutes: z.number().optional(),
});

export const siblingsSchema = z.object({
  span_id: z.string(),
});

export const failingSchema = z.object({
  error_pattern: z.string().optional(),
  last_n_minutes: z.number().optional(),
});

// ─── Tool Implementations ───

export async function flightboxSummary(
  params: z.infer<typeof summarySchema>,
) {
  const where = and(
    params.trace_id ? `trace_id = '${esc(params.trace_id)}'` : "",
    timeFilter(params.last_n_minutes),
  );

  // If no trace_id given, find most recent trace
  let traceId = params.trace_id;
  if (!traceId) {
    const recent = await query(
      fromSpans(
        timeFilter(params.last_n_minutes) || undefined,
        "started_at DESC",
      ) + " LIMIT 1",
    );
    if (recent.length === 0) return { error: "No traces found" };
    traceId = recent[0].trace_id as string;
  }

  const traceWhere = and(
    `trace_id = '${esc(traceId)}'`,
    timeFilter(params.last_n_minutes),
  );

  const [spans, countResult] = await Promise.all([
    query(fromSpans(traceWhere, "started_at ASC")),
    query(countSpans(traceWhere)),
  ]);

  if (spans.length === 0) return { error: "Trace not found" };

  const totalSpans = Number((countResult[0] as any).cnt);
  const root = spans.find((s) => !s.parent_id || s.parent_id === "");
  const errors = spans.filter((s) => s.error && s.error !== "");
  const sorted = [...spans]
    .filter((s) => s.duration_ms != null)
    .sort((a, b) => Number(b.duration_ms) - Number(a.duration_ms));
  const topSlowest = sorted.slice(0, 5).map((s) => ({
    span_id: s.span_id,
    name: s.name,
    duration_ms: s.duration_ms,
  }));

  const rootStarted = Number(root?.started_at ?? spans[0].started_at);
  const maxEnded = Math.max(
    ...spans.map((s) => Number(s.ended_at || s.started_at)),
  );

  return {
    trace_id: traceId,
    root_span: root
      ? { span_id: root.span_id, name: root.name, module: root.module }
      : null,
    total_spans: totalSpans,
    duration_ms: maxEnded - rootStarted,
    top_slowest: topSlowest,
    errors: errors.map((e) => ({
      span_id: e.span_id,
      name: e.name,
      error: e.error,
    })),
  };
}

export async function flightboxChildren(
  params: z.infer<typeof childrenSchema>,
) {
  const spans = await query(
    fromSpans(
      `parent_id = '${esc(params.span_id)}'`,
      "started_at ASC",
    ),
  );

  return spans.map((s) => ({
    span_id: s.span_id,
    name: s.name,
    duration_ms: s.duration_ms,
    has_error: !!(s.error && s.error !== ""),
    ...(params.include_args ? { input: s.input, output: s.output } : {}),
  }));
}

export async function flightboxInspect(
  params: z.infer<typeof inspectSchema>,
) {
  const spans = await query(
    fromSpans(`span_id = '${esc(params.span_id)}'`) + " LIMIT 1",
  );

  if (spans.length === 0) return { error: "Span not found" };
  return spans[0];
}

export async function flightboxWalk(
  params: z.infer<typeof walkSchema>,
) {
  const start = await query(
    fromSpans(`span_id = '${esc(params.span_id)}'`) + " LIMIT 1",
  );
  if (start.length === 0) return { error: "Span not found" };

  const chain: Record<string, unknown>[] = [];
  const visited = new Set<string>();

  // Walk up (ancestors)
  if (params.direction === "up" || params.direction === "both") {
    let current = start[0];
    let depth = 0;
    while (
      current.parent_id &&
      current.parent_id !== "" &&
      depth < params.depth
    ) {
      if (visited.has(current.parent_id as string)) break;
      visited.add(current.parent_id as string);

      const parent = await query(
        fromSpans(`span_id = '${esc(current.parent_id as string)}'`) +
          " LIMIT 1",
      );
      if (parent.length === 0) break;
      chain.unshift({
        span_id: parent[0].span_id,
        name: parent[0].name,
        duration_ms: parent[0].duration_ms,
        has_error: !!(parent[0].error && parent[0].error !== ""),
      });
      current = parent[0];
      depth++;
    }
  }

  // Add current span
  chain.push({
    span_id: start[0].span_id,
    name: start[0].name,
    duration_ms: start[0].duration_ms,
    has_error: !!(start[0].error && start[0].error !== ""),
    is_target: true,
  });

  // Walk down (descendants)
  if (params.direction === "down" || params.direction === "both") {
    async function walkDown(parentId: string, depth: number) {
      if (depth <= 0) return;
      const children = await query(
        fromSpans(`parent_id = '${esc(parentId)}'`, "started_at ASC"),
      );
      for (const child of children) {
        chain.push({
          span_id: child.span_id,
          name: child.name,
          duration_ms: child.duration_ms,
          has_error: !!(child.error && child.error !== ""),
        });
        await walkDown(child.span_id as string, depth - 1);
      }
    }
    await walkDown(params.span_id, params.depth);
  }

  return chain;
}

export async function flightboxSearch(
  params: z.infer<typeof searchSchema>,
) {
  const clauses: string[] = [];

  if (params.text) {
    const t = esc(params.text);
    clauses.push(
      `(name ILIKE '%${t}%' OR input ILIKE '%${t}%' OR output ILIKE '%${t}%' OR error ILIKE '%${t}%')`,
    );
  }
  if (params.name_pattern) {
    clauses.push(`name ILIKE '%${esc(params.name_pattern)}%'`);
  }
  if (params.has_error) {
    clauses.push(`error IS NOT NULL AND error != ''`);
  }
  if (params.min_duration_ms != null) {
    clauses.push(`duration_ms >= ${params.min_duration_ms}`);
  }
  if (params.trace_id) {
    clauses.push(`trace_id = '${esc(params.trace_id)}'`);
  }
  const tf = timeFilter(params.last_n_minutes);
  if (tf) clauses.push(tf);

  // For ancestor_of / descendant_of, we need to resolve the chain
  if (params.ancestor_of) {
    const ancestors = await resolveAncestors(params.ancestor_of);
    if (ancestors.length > 0) {
      clauses.push(
        `span_id IN (${ancestors.map((a) => `'${esc(a)}'`).join(",")})`,
      );
    }
  }
  if (params.descendant_of) {
    const descendants = await resolveDescendants(params.descendant_of);
    if (descendants.length > 0) {
      clauses.push(
        `span_id IN (${descendants.map((d) => `'${esc(d)}'`).join(",")})`,
      );
    }
  }

  const where = clauses.length > 0 ? clauses.join(" AND ") : undefined;
  const spans = await query(
    fromSpans(where, "started_at DESC") + " LIMIT 50",
  );

  return spans.map((s) => ({
    span_id: s.span_id,
    trace_id: s.trace_id,
    name: s.name,
    module: s.module,
    duration_ms: s.duration_ms,
    has_error: !!(s.error && s.error !== ""),
  }));
}

export async function flightboxSiblings(
  params: z.infer<typeof siblingsSchema>,
) {
  const span = await query(
    fromSpans(`span_id = '${esc(params.span_id)}'`) + " LIMIT 1",
  );
  if (span.length === 0) return { error: "Span not found" };

  const parentId = span[0].parent_id as string;
  if (!parentId || parentId === "") {
    return { error: "Span has no parent (root span)" };
  }

  const siblings = await query(
    fromSpans(`parent_id = '${esc(parentId)}'`, "started_at ASC"),
  );

  return siblings.map((s) => ({
    span_id: s.span_id,
    name: s.name,
    duration_ms: s.duration_ms,
    has_error: !!(s.error && s.error !== ""),
    is_self: s.span_id === params.span_id,
  }));
}

export async function flightboxFailing(
  params: z.infer<typeof failingSchema>,
) {
  const clauses: string[] = [`error IS NOT NULL AND error != ''`];
  const tf = timeFilter(params.last_n_minutes);
  if (tf) clauses.push(tf);
  if (params.error_pattern) {
    clauses.push(`error ILIKE '%${esc(params.error_pattern)}%'`);
  }

  const spans = await query(
    fromSpans(clauses.join(" AND "), "started_at DESC") + " LIMIT 50",
  );

  // Group by error type (extract error name if possible)
  const groups: Record<string, typeof spans> = {};
  for (const s of spans) {
    let errorKey = "unknown";
    try {
      const parsed = JSON.parse(s.error as string);
      errorKey = parsed.name || "Error";
    } catch {
      errorKey = String(s.error).slice(0, 50);
    }
    (groups[errorKey] ??= []).push(s);
  }

  return Object.entries(groups).map(([errorType, spans]) => ({
    error_type: errorType,
    count: spans.length,
    spans: spans.map((s) => ({
      span_id: s.span_id,
      trace_id: s.trace_id,
      name: s.name,
      module: s.module,
      error: s.error,
    })),
  }));
}

// ─── Raw SQL Query ───

export const querySchema = z.object({
  sql: z.string().describe(
    "SQL query against the spans table. Use `spans` as the table name. " +
    "Columns: span_id, trace_id, parent_id, kind, name, module, file_line, " +
    "input (JSON string), output (JSON string), error (JSON string), " +
    "context (JSON string — serialized `this` for class methods, null otherwise), " +
    "started_at (BIGINT epoch ms), ended_at (BIGINT epoch ms), duration_ms (DOUBLE), " +
    "git_sha, tags. " +
    "DuckDB SQL — supports JSON_EXTRACT_STRING(input, '$[0].id'), aggregations, window functions, etc. " +
    "Example: SELECT name, COUNT(*) as calls, AVG(duration_ms) as avg_ms FROM spans GROUP BY name ORDER BY avg_ms DESC LIMIT 20",
  ),
});

export async function flightboxQuery(
  params: z.infer<typeof querySchema>,
) {
  // Replace `spans` table reference with the parquet glob read
  const glob = `'${getTracesDir()}/*.parquet'`;
  const parquetFrom = `read_parquet(${glob}, union_by_name=true)`;
  const sql = params.sql.replace(/\bspans\b/gi, parquetFrom);

  try {
    const rows = await query(sql);
    return { rows, count: rows.length };
  } catch (err) {
    return { error: String(err) };
  }
}

// ─── Helpers ───

async function resolveAncestors(
  spanId: string,
  maxDepth = 20,
): Promise<string[]> {
  const ids: string[] = [];
  let current = spanId;
  for (let i = 0; i < maxDepth; i++) {
    const rows = await query(
      fromSpans(`span_id = '${esc(current)}'`) + " LIMIT 1",
    );
    if (rows.length === 0 || !rows[0].parent_id || rows[0].parent_id === "")
      break;
    current = rows[0].parent_id as string;
    ids.push(current);
  }
  return ids;
}

async function resolveDescendants(
  spanId: string,
  maxDepth = 5,
): Promise<string[]> {
  const ids: string[] = [];
  const queue = [{ id: spanId, depth: 0 }];
  while (queue.length > 0) {
    const item = queue.shift()!;
    if (item.depth >= maxDepth) continue;
    const children = await query(
      fromSpans(`parent_id = '${esc(item.id)}'`),
    );
    for (const child of children) {
      const childId = child.span_id as string;
      ids.push(childId);
      queue.push({ id: childId, depth: item.depth + 1 });
    }
  }
  return ids;
}
