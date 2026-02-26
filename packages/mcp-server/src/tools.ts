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

type SpanRow = Record<string, unknown>;

interface EntityEventRow {
  action: string;
  entity_type: string;
  entity_id?: string;
  snapshot?: string | null;
  changes?: string | null;
  note?: string;
  dimensions?: Record<string, string | number | boolean | null>;
  at: number;
  span_id: string;
  trace_id: string;
  parent_id: string | null;
  name: string;
  module: string;
  started_at: number;
  duration_ms: number | null;
  has_error: boolean;
}

interface EntityEventFilter {
  entity_type?: string;
  entity_id?: string;
  action?: string;
  trace_id?: string;
  last_n_minutes?: number;
  limit?: number;
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

export const recentSchema = z.object({
  since_started_at: z.number().optional(),
  since_span_id: z.string().optional(),
  trace_id: z.string().optional(),
  has_error: z.boolean().optional(),
  limit: z.number().default(200),
});

export const siblingsSchema = z.object({
  span_id: z.string(),
});

export const failingSchema = z.object({
  error_pattern: z.string().optional(),
  last_n_minutes: z.number().optional(),
});

export const entitiesSchema = z.object({
  entity_type: z.string().optional(),
  action: z.enum(["create", "update", "delete", "upsert", "custom"]).optional(),
  trace_id: z.string().optional(),
  last_n_minutes: z.number().optional(),
  limit: z.number().default(200),
});

export const entityTimelineSchema = z.object({
  entity_type: z.string(),
  entity_id: z.string().optional(),
  action: z.enum(["create", "update", "delete", "upsert", "custom"]).optional(),
  trace_id: z.string().optional(),
  last_n_minutes: z.number().optional(),
  limit: z.number().default(200),
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
  const out: Record<string, unknown>[] = [];
  const visited = new Set<string>();
  const maxDepth = Math.max(1, params.depth ?? 1);

  async function walk(parentId: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;

    const spans = await query(
      fromSpans(
        `parent_id = '${esc(parentId)}'`,
        "started_at ASC",
      ),
    );

    for (const s of spans) {
      const spanId = String(s.span_id);
      if (visited.has(spanId)) continue;
      visited.add(spanId);

      out.push({
        span_id: s.span_id,
        parent_id: s.parent_id,
        depth,
        name: s.name,
        duration_ms: s.duration_ms,
        has_error: !!(s.error && s.error !== ""),
        ...(params.include_args ? { input: s.input, output: s.output } : {}),
      });

      await walk(spanId, depth + 1);
    }
  }

  await walk(params.span_id, 1);
  return out;
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
  if (params.has_error !== undefined) {
    clauses.push(
      params.has_error
        ? `error IS NOT NULL AND error != ''`
        : `(error IS NULL OR error = '')`,
    );
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

export async function flightboxRecent(
  params: z.infer<typeof recentSchema>,
) {
  const clauses: string[] = [];
  const limit = Math.max(1, Math.min(1000, Math.floor(params.limit)));

  if (params.trace_id) {
    clauses.push(`trace_id = '${esc(params.trace_id)}'`);
  }
  if (params.has_error !== undefined) {
    clauses.push(
      params.has_error
        ? `error IS NOT NULL AND error != ''`
        : `(error IS NULL OR error = '')`,
    );
  }
  if (params.since_started_at != null) {
    const since = Math.floor(params.since_started_at);
    if (params.since_span_id) {
      clauses.push(
        `(started_at > ${since} OR (started_at = ${since} AND span_id > '${esc(params.since_span_id)}'))`,
      );
    } else {
      clauses.push(`started_at > ${since}`);
    }
  }

  const where = clauses.length > 0 ? clauses.join(" AND ") : undefined;
  const spans = await query(
    fromSpans(where, "started_at ASC, span_id ASC") + ` LIMIT ${limit}`,
  );

  const items = spans.map((s) => ({
    span_id: String(s.span_id ?? ""),
    parent_id: String(s.parent_id ?? ""),
    trace_id: String(s.trace_id ?? ""),
    name: String(s.name ?? ""),
    module: String(s.module ?? ""),
    started_at: toNumber(s.started_at) ?? 0,
    ended_at: toNumber(s.ended_at) ?? 0,
    duration_ms: toNumber(s.duration_ms) ?? 0,
    has_error: !!(s.error && s.error !== ""),
  }));

  const last = items.at(-1);
  return {
    count: items.length,
    spans: items,
    has_more: items.length === limit,
    next_cursor: last
      ? {
          since_started_at: last.started_at,
          since_span_id: last.span_id,
        }
      : {
          since_started_at: params.since_started_at ?? null,
          since_span_id: params.since_span_id ?? null,
        },
  };
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

export async function flightboxEntities(
  params: z.infer<typeof entitiesSchema>,
) {
  const events = await loadEntityEvents(params);
  const byType = new Map<string, {
    total_events: number;
    actions: Record<string, number>;
    entity_ids: Set<string>;
    first_seen_at: number;
    last_seen_at: number;
  }>();

  for (const ev of events) {
    const bucket = byType.get(ev.entity_type) ?? {
      total_events: 0,
      actions: {},
      entity_ids: new Set<string>(),
      first_seen_at: ev.at,
      last_seen_at: ev.at,
    };
    bucket.total_events++;
    bucket.actions[ev.action] = (bucket.actions[ev.action] ?? 0) + 1;
    if (ev.entity_id) bucket.entity_ids.add(ev.entity_id);
    bucket.first_seen_at = Math.min(bucket.first_seen_at, ev.at);
    bucket.last_seen_at = Math.max(bucket.last_seen_at, ev.at);
    byType.set(ev.entity_type, bucket);
  }

  const types = [...byType.entries()]
    .map(([entityType, bucket]) => ({
      entity_type: entityType,
      total_events: bucket.total_events,
      unique_entities: bucket.entity_ids.size,
      actions: bucket.actions,
      first_seen_at: bucket.first_seen_at,
      last_seen_at: bucket.last_seen_at,
    }))
    .sort((a, b) => b.total_events - a.total_events);

  return {
    total_events: events.length,
    unique_entity_types: types.length,
    entity_types: types,
    sample_events: events.slice(0, Math.max(1, Math.min(20, params.limit))),
  };
}

export async function flightboxEntityTimeline(
  params: z.infer<typeof entityTimelineSchema>,
) {
  const events = await loadEntityEvents({
    ...params,
    entity_type: params.entity_type,
  });

  const timeline = events
    .sort((a, b) => a.at - b.at)
    .slice(0, Math.max(1, Math.min(1000, params.limit)));

  const callGraphAnchors = timeline.map((ev) => ({
    at: ev.at,
    action: ev.action,
    entity_type: ev.entity_type,
    entity_id: ev.entity_id,
    span_id: ev.span_id,
    parent_id: ev.parent_id,
    trace_id: ev.trace_id,
    function: ev.name,
    module: ev.module,
  }));

  return {
    entity_type: params.entity_type,
    entity_id: params.entity_id ?? null,
    total_events: timeline.length,
    timeline,
    call_graph_anchors: callGraphAnchors,
  };
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

async function loadEntityEvents(
  filter: EntityEventFilter,
): Promise<EntityEventRow[]> {
  const where = and(
    `tags IS NOT NULL`,
    `tags != ''`,
    filter.trace_id ? `trace_id = '${esc(filter.trace_id)}'` : "",
    timeFilter(filter.last_n_minutes),
  );

  const rows = await query(
    fromSpans(where, "started_at DESC") +
      ` LIMIT ${Math.max(100, Math.min(10000, (filter.limit ?? 200) * 10))}`,
  );

  const events = rows.flatMap(parseEntityEventsFromSpan);
  return events
    .filter((ev) => !filter.entity_type || ev.entity_type === filter.entity_type)
    .filter((ev) => !filter.entity_id || ev.entity_id === filter.entity_id)
    .filter((ev) => !filter.action || ev.action === filter.action)
    .sort((a, b) => b.at - a.at)
    .slice(0, Math.max(1, Math.min(2000, filter.limit ?? 200)));
}

function parseEntityEventsFromSpan(span: SpanRow): EntityEventRow[] {
  const tagsRaw = span.tags;
  if (!tagsRaw || typeof tagsRaw !== "string") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(tagsRaw);
  } catch {
    return [];
  }

  const entities = (parsed as { entities?: unknown[] }).entities;
  if (!Array.isArray(entities) || entities.length === 0) return [];

  const spanId = String(span.span_id ?? "");
  const traceId = String(span.trace_id ?? "");
  if (!spanId || !traceId) return [];

  const parentIdRaw = span.parent_id;
  const parentId = parentIdRaw && String(parentIdRaw).length > 0
    ? String(parentIdRaw)
    : null;

  const startedAt = toNumber(span.started_at) ?? Date.now();
  const durationMs = toNumber(span.duration_ms);
  const hasError = !!(span.error && span.error !== "");

  const out: EntityEventRow[] = [];
  for (const entity of entities) {
    if (!entity || typeof entity !== "object") continue;
    const raw = entity as Record<string, unknown>;
    const entityType = typeof raw.entity_type === "string"
      ? raw.entity_type
      : "";
    const action = typeof raw.action === "string" ? raw.action : "";
    if (!entityType || !action) continue;

    const at = toNumber(raw.at) ?? startedAt;
    out.push({
      action,
      entity_type: entityType,
      entity_id: typeof raw.entity_id === "string" ? raw.entity_id : undefined,
      snapshot: typeof raw.snapshot === "string" ? raw.snapshot : null,
      changes: typeof raw.changes === "string" ? raw.changes : null,
      note: typeof raw.note === "string" ? raw.note : undefined,
      dimensions: isRecord(raw.dimensions) ? normalizeDimensions(raw.dimensions) : undefined,
      at,
      span_id: spanId,
      trace_id: traceId,
      parent_id: parentId,
      name: String(span.name ?? ""),
      module: String(span.module ?? ""),
      started_at: startedAt,
      duration_ms: durationMs,
      has_error: hasError,
    });
  }

  return out;
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

function toNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function normalizeDimensions(
  input: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(input)) {
    if (
      v === null ||
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      out[k] = v;
    }
  }
  return out;
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
