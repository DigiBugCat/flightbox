import { z } from "zod";
import {
  query,
  fromSpans,
  fromSpansInline,
  countSpans,
  getTracesDir,
  getConfiguredEntityTypes,
  causalEdgesViewSql,
  entityEventsViewSql,
} from "./db.js";

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

interface EntityEventRowWithDiff extends EntityEventRow {
  diff?: Record<string, { from: unknown; to: unknown }> | null;
}

interface EntityEventFilter {
  entity_type?: string;
  entity_id?: string;
  action?: string;
  trace_id?: string;
  last_n_minutes?: number;
  limit?: number;
}

interface CausalEdge {
  from_node_id: string;
  to_node_id: string;
  edge_kind: "call" | "lineage";
  evidence_kind: "exact" | "inferred" | "gap";
  confidence: number;
  trace_id?: string;
  at?: number;
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
  field_filter: z.string().optional().describe(
    "Filter to events where this field changed in the snapshot (e.g. 'position', 'state'). " +
    "Also computes diffs between consecutive snapshots for this field.",
  ),
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
  const edges = await loadCausalEdges();
  const lineageChildren = edges
    .filter((edge) => edge.from_node_id === params.span_id && edge.edge_kind === "lineage")
    .map((edge) => edge.to_node_id);

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

  if (lineageChildren.length > 0) {
    const linked = await query(
      fromSpans(
        `span_id IN (${lineageChildren.map((id) => `'${esc(id)}'`).join(",")})`,
        "started_at ASC",
      ),
    );
    for (const s of linked) {
      out.push({
        span_id: s.span_id,
        parent_id: params.span_id,
        depth: 1,
        name: s.name,
        duration_ms: s.duration_ms,
        has_error: !!(s.error && s.error !== ""),
        cross_process: true,
        via_edge: "lineage",
      });
    }
  }

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

  // Scope to the trace to avoid loading all spans into memory
  const traceId = String(start[0].trace_id);
  const spans = await query(
    fromSpans(`trace_id = '${esc(traceId)}'`, "started_at ASC"),
  );

  const spanById = new Map<string, Record<string, unknown>>();
  for (const span of spans) {
    spanById.set(String(span.span_id), span);
  }

  const edges = await loadCausalEdges({ trace_id: traceId });
  const outgoing = new Map<string, CausalEdge[]>();
  const incoming = new Map<string, CausalEdge[]>();
  for (const edge of edges) {
    const out = outgoing.get(edge.from_node_id) ?? [];
    out.push(edge);
    outgoing.set(edge.from_node_id, out);

    const inc = incoming.get(edge.to_node_id) ?? [];
    inc.push(edge);
    incoming.set(edge.to_node_id, inc);
  }

  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();

  if (params.direction === "up" || params.direction === "both") {
    const queue: Array<{ id: string; depth: number }> = [{ id: params.span_id, depth: 0 }];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= params.depth) continue;
      for (const edge of incoming.get(current.id) ?? []) {
        const parent = spanById.get(edge.from_node_id);
        if (!parent) continue;
        const key = `up:${edge.from_node_id}:${edge.to_node_id}:${edge.edge_kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          span_id: parent.span_id,
          name: parent.name,
          duration_ms: parent.duration_ms,
          has_error: !!(parent.error && parent.error !== ""),
          via_edge: edge.edge_kind,
          evidence_kind: edge.evidence_kind,
          confidence: edge.confidence,
          direction: "up",
          depth: current.depth + 1,
        });
        queue.push({ id: edge.from_node_id, depth: current.depth + 1 });
      }
    }
  }

  const startSpan = start[0];
  out.push({
    span_id: startSpan.span_id,
    name: startSpan.name,
    duration_ms: startSpan.duration_ms,
    has_error: !!(startSpan.error && startSpan.error !== ""),
    is_target: true,
    confidence: 1,
  });

  if (params.direction === "down" || params.direction === "both") {
    const queue: Array<{ id: string; depth: number }> = [{ id: params.span_id, depth: 0 }];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth >= params.depth) continue;
      for (const edge of outgoing.get(current.id) ?? []) {
        const child = spanById.get(edge.to_node_id);
        if (!child) continue;
        const key = `down:${edge.from_node_id}:${edge.to_node_id}:${edge.edge_kind}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          span_id: child.span_id,
          name: child.name,
          duration_ms: child.duration_ms,
          has_error: !!(child.error && child.error !== ""),
          via_edge: edge.edge_kind,
          evidence_kind: edge.evidence_kind,
          confidence: edge.confidence,
          direction: "down",
          depth: current.depth + 1,
        });
        queue.push({ id: edge.to_node_id, depth: current.depth + 1 });
      }
    }
  }

  return out;
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
  const configuredTypes = getConfiguredEntityTypes();
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

  const observedTypes = types.map((t) => t.entity_type);
  const observedSet = new Set(observedTypes);
  const configuredSet = new Set(configuredTypes);
  const unobservedConfigured = configuredTypes.filter((type) => !observedSet.has(type));
  const unknownObserved = observedTypes.filter((type) => configuredSet.size > 0 && !configuredSet.has(type));

  return {
    total_events: events.length,
    unique_entity_types: types.length,
    coverage: {
      configured_entity_types: configuredTypes,
      observed_entity_types: observedTypes,
      unobserved_configured_types: unobservedConfigured,
      unknown_observed_types: unknownObserved,
    },
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

  let timeline = events
    .sort((a, b) => a.at - b.at)
    .slice(0, Math.max(1, Math.min(1000, params.limit)));

  // Compute diffs between consecutive snapshots per entity_id
  const enriched = computeSnapshotDiffs(timeline, params.field_filter);

  // Apply field_filter: keep only events where the filtered field changed
  if (params.field_filter) {
    const field = params.field_filter;
    timeline = enriched.filter((ev) => {
      if (!ev.diff) return false;
      const diff = ev.diff as Record<string, unknown>;
      return field in diff;
    });
  } else {
    timeline = enriched;
  }

  // Collect trace_ids from timeline for scoped edge loading
  const traceIds = [...new Set(timeline.map((ev) => ev.trace_id).filter(Boolean))];
  const edges = await loadCausalEdges(
    traceIds.length > 0 ? { trace_ids: traceIds } : undefined,
  );
  const incomingBySpan = new Map<string, CausalEdge[]>();
  const outgoingBySpan = new Map<string, CausalEdge[]>();
  for (const edge of edges) {
    const incoming = incomingBySpan.get(edge.to_node_id) ?? [];
    incoming.push(edge);
    incomingBySpan.set(edge.to_node_id, incoming);

    const outgoing = outgoingBySpan.get(edge.from_node_id) ?? [];
    outgoing.push(edge);
    outgoingBySpan.set(edge.from_node_id, outgoing);
  }

  const callGraphAnchors = timeline.map((ev) => ({
    at: ev.at,
    action: ev.action,
    entity_type: ev.entity_type,
    entity_id: ev.entity_id,
    snapshot: ev.snapshot,
    diff: (ev as EntityEventRowWithDiff).diff ?? null,
    span_id: ev.span_id,
    parent_id: ev.parent_id,
    trace_id: ev.trace_id,
    function: ev.name,
    module: ev.module,
  }));

  const crossProcessLinks = timeline.flatMap((ev) => {
    const incoming = (incomingBySpan.get(ev.span_id) ?? []).filter((edge) => edge.edge_kind === "lineage");
    const outgoing = (outgoingBySpan.get(ev.span_id) ?? []).filter((edge) => edge.edge_kind === "lineage");
    return [
      ...incoming.map((edge) => ({
        direction: "incoming",
        from_span_id: edge.from_node_id,
        to_span_id: edge.to_node_id,
        evidence_kind: edge.evidence_kind,
        confidence: edge.confidence,
      })),
      ...outgoing.map((edge) => ({
        direction: "outgoing",
        from_span_id: edge.from_node_id,
        to_span_id: edge.to_node_id,
        evidence_kind: edge.evidence_kind,
        confidence: edge.confidence,
      })),
    ];
  });

  return {
    entity_type: params.entity_type,
    entity_id: params.entity_id ?? null,
    total_events: timeline.length,
    field_filter: params.field_filter ?? null,
    timeline: callGraphAnchors,
    call_graph_anchors: callGraphAnchors,
    cross_process_links: crossProcessLinks,
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

// ─── Pattern Detection Tools ───

export const hotspotsSchema = z.object({
  last_n_minutes: z.number().optional(),
  min_calls: z.number().default(10).describe("Minimum total calls to include in results"),
  limit: z.number().default(20),
});

export async function flightboxHotspots(
  params: z.infer<typeof hotspotsSchema>,
) {
  const tf = timeFilter(params.last_n_minutes);
  const whereClause = tf ? `WHERE ${tf}` : "";

  // Compute the actual time window for calls_per_minute calculation
  const windowMinutes = params.last_n_minutes ?? 60;

  const sql = `
SELECT
  name,
  module,
  COUNT(*) AS total_calls,
  ROUND(COUNT(*) * 1.0 / ${windowMinutes}, 1) AS calls_per_minute,
  ROUND(AVG(duration_ms), 3) AS avg_ms,
  ROUND(MIN(duration_ms), 3) AS min_ms,
  ROUND(MAX(duration_ms), 3) AS max_ms,
  SUM(CASE WHEN error IS NOT NULL AND error != '' THEN 1 ELSE 0 END) AS error_count
FROM ${fromSpansInline()}
${whereClause}
GROUP BY name, module
HAVING COUNT(*) >= ${Math.max(1, params.min_calls)}
ORDER BY total_calls DESC
LIMIT ${Math.max(1, Math.min(100, params.limit))}
`;

  try {
    const rows = await query(sql);
    return { hotspots: rows, window_minutes: windowMinutes };
  } catch (err) {
    return { error: String(err) };
  }
}

export const inputStabilitySchema = z.object({
  name_pattern: z.string().describe("Function name pattern to search (case-insensitive substring match)"),
  last_n_minutes: z.number().optional(),
  limit: z.number().default(20),
});

export async function flightboxInputStability(
  params: z.infer<typeof inputStabilitySchema>,
) {
  const clauses = [`name ILIKE '%${esc(params.name_pattern)}%'`];
  const tf = timeFilter(params.last_n_minutes);
  if (tf) clauses.push(tf);

  const sql = `
SELECT
  name,
  module,
  input,
  md5(COALESCE(input, '')) AS input_hash,
  COUNT(*) AS call_count,
  ROUND(AVG(duration_ms), 3) AS avg_ms,
  MIN(started_at) AS first_at,
  MAX(started_at) AS last_at
FROM ${fromSpansInline()}
WHERE ${clauses.join(" AND ")}
GROUP BY name, module, input, md5(COALESCE(input, ''))
ORDER BY call_count DESC
LIMIT ${Math.max(1, Math.min(100, params.limit))}
`;

  try {
    const rows = await query(sql);
    return {
      repeated_inputs: rows,
      total_groups: rows.length,
    };
  } catch (err) {
    return { error: String(err) };
  }
}

export const intervalsSchema = z.object({
  name_pattern: z.string().describe("Function name pattern to search (case-insensitive substring match)"),
  last_n_minutes: z.number().optional(),
  limit: z.number().default(10),
});

export async function flightboxIntervals(
  params: z.infer<typeof intervalsSchema>,
) {
  const clauses = [`name ILIKE '%${esc(params.name_pattern)}%'`];
  const tf = timeFilter(params.last_n_minutes);
  if (tf) clauses.push(tf);

  const sql = `
WITH ordered AS (
  SELECT
    name, module, started_at,
    LAG(started_at) OVER (PARTITION BY name, module ORDER BY started_at) AS prev_at
  FROM ${fromSpansInline()}
  WHERE ${clauses.join(" AND ")}
),
intervals AS (
  SELECT name, module, (started_at - prev_at) AS interval_ms
  FROM ordered
  WHERE prev_at IS NOT NULL
)
SELECT
  name,
  module,
  COUNT(*) AS interval_count,
  ROUND(AVG(interval_ms), 1) AS avg_interval_ms,
  MIN(interval_ms) AS min_interval_ms,
  MAX(interval_ms) AS max_interval_ms,
  ROUND(STDDEV(interval_ms), 1) AS stddev_interval_ms
FROM intervals
GROUP BY name, module
ORDER BY avg_interval_ms ASC
LIMIT ${Math.max(1, Math.min(100, params.limit))}
`;

  try {
    const rows = await query(sql);
    return { intervals: rows };
  } catch (err) {
    return { error: String(err) };
  }
}

export const oscillationSchema = z.object({
  entity_type: z.string().optional().describe(
    "Entity type to check for oscillation (uses entity_events from trackEntityUpdate). " +
    "Omit entity_type and provide span_name + input_path instead to detect oscillation on raw span input fields.",
  ),
  entity_id: z.string().optional(),
  field_path: z.string().describe(
    "Field to check for ping-pong. For entity mode: top-level snapshot key (e.g. 'state'). " +
    "For span mode: JSON path into span input (e.g. '$[0].position.y').",
  ),
  span_name: z.string().optional().describe(
    "Span function name for raw span input mode (alternative to entity_type). " +
    "Use this when entity tracking isn't wired up.",
  ),
  input_path: z.string().optional().describe(
    "JSON path into span input for raw span mode (e.g. '$[0].agents.agent-id.position.y'). " +
    "Used with span_name.",
  ),
  last_n_minutes: z.number().optional(),
  min_flips: z.number().default(3).describe("Minimum direction reversals to flag as oscillating"),
});

export async function flightboxOscillation(
  params: z.infer<typeof oscillationSchema>,
) {
  // Span input mode: detect oscillation on raw span input fields
  if (params.span_name && params.input_path) {
    return detectSpanInputOscillation(params);
  }

  // Entity mode: detect oscillation on entity snapshot fields
  if (!params.entity_type) {
    return { error: "Provide either entity_type (entity mode) or span_name + input_path (span mode)" };
  }

  return detectEntityOscillation(params);
}

async function detectEntityOscillation(params: z.infer<typeof oscillationSchema>) {
  const clauses = [`entity_type = '${esc(params.entity_type!)}'`];
  if (params.entity_id) clauses.push(`entity_id = '${esc(params.entity_id)}'`);
  const tf = timeFilter(params.last_n_minutes);
  if (tf) clauses.push(tf);

  const fieldPath = esc(params.field_path);

  // Use entityEventsViewSql as a base, then apply LAG to detect oscillation
  const sql = `
WITH events AS (
  ${entityEventsViewSql()}
),
filtered AS (
  SELECT
    entity_id,
    event_at,
    json_extract_string(snapshot, '$.${fieldPath}') AS field_value
  FROM events
  WHERE ${clauses.join(" AND ")}
    AND snapshot IS NOT NULL
    AND json_extract_string(snapshot, '$.${fieldPath}') IS NOT NULL
),
with_neighbors AS (
  SELECT
    entity_id,
    event_at,
    field_value,
    LAG(field_value) OVER (PARTITION BY entity_id ORDER BY event_at) AS prev_value,
    LEAD(field_value) OVER (PARTITION BY entity_id ORDER BY event_at) AS next_value
  FROM filtered
),
reversals AS (
  SELECT entity_id, field_value, prev_value, next_value, event_at
  FROM with_neighbors
  WHERE prev_value IS NOT NULL AND next_value IS NOT NULL
    AND prev_value = next_value
    AND prev_value != field_value
)
SELECT
  entity_id,
  COUNT(*) AS flip_count,
  MIN(event_at) AS first_flip_at,
  MAX(event_at) AS last_flip_at,
  ARRAY_AGG(DISTINCT field_value ORDER BY field_value) AS oscillating_values
FROM reversals
GROUP BY entity_id
HAVING COUNT(*) >= ${Math.max(1, params.min_flips)}
ORDER BY flip_count DESC
LIMIT 50
`;

  try {
    const rows = await query(sql);
    return {
      mode: "entity",
      entity_type: params.entity_type,
      field: params.field_path,
      min_flips: params.min_flips,
      oscillating_entities: rows,
    };
  } catch (err) {
    return { error: String(err) };
  }
}

async function detectSpanInputOscillation(params: z.infer<typeof oscillationSchema>) {
  const clauses = [`name = '${esc(params.span_name!)}'`];
  const tf = timeFilter(params.last_n_minutes);
  if (tf) clauses.push(tf);

  const inputPath = esc(params.input_path ?? params.field_path);

  const sql = `
WITH ordered AS (
  SELECT
    started_at,
    json_extract_string(input, '${inputPath}') AS field_value
  FROM ${fromSpansInline()}
  WHERE ${clauses.join(" AND ")}
    AND json_extract_string(input, '${inputPath}') IS NOT NULL
),
with_neighbors AS (
  SELECT
    started_at,
    field_value,
    LAG(field_value) OVER (ORDER BY started_at) AS prev_value,
    LEAD(field_value) OVER (ORDER BY started_at) AS next_value
  FROM ordered
),
reversals AS (
  SELECT field_value, prev_value, next_value, started_at
  FROM with_neighbors
  WHERE prev_value IS NOT NULL AND next_value IS NOT NULL
    AND prev_value = next_value
    AND prev_value != field_value
)
SELECT
  COUNT(*) AS flip_count,
  MIN(started_at) AS first_flip_at,
  MAX(started_at) AS last_flip_at,
  ARRAY_AGG(DISTINCT field_value ORDER BY field_value) AS oscillating_values,
  ARRAY_AGG(DISTINCT prev_value ORDER BY prev_value) AS stable_values
FROM reversals
HAVING COUNT(*) >= ${Math.max(1, params.min_flips)}
`;

  try {
    const rows = await query(sql);
    return {
      mode: "span_input",
      span_name: params.span_name,
      input_path: params.input_path ?? params.field_path,
      min_flips: params.min_flips,
      result: rows.length > 0 ? rows[0] : { flip_count: 0, oscillating_values: [] },
    };
  } catch (err) {
    return { error: String(err) };
  }
}

async function loadCausalEdges(filter?: {
  trace_id?: string;
  trace_ids?: string[];
  last_n_minutes?: number;
}): Promise<CausalEdge[]> {
  let traceFilter = "";
  if (filter?.trace_ids && filter.trace_ids.length > 0) {
    traceFilter = `trace_id IN (${filter.trace_ids.map((id) => `'${esc(id)}'`).join(",")})`;
  } else if (filter?.trace_id) {
    traceFilter = `trace_id = '${esc(filter.trace_id)}'`;
  }
  const where = and(
    traceFilter,
    timeFilter(filter?.last_n_minutes),
  );
  const rows = await query(causalEdgesViewSql(where || undefined));

  const edges: CausalEdge[] = [];
  for (const row of rows) {
    const fromNodeId = String(row.from_node_id ?? "");
    const toNodeId = String(row.to_node_id ?? "");
    const edgeKind = String(row.edge_kind ?? "");
    const evidenceKind = String(row.evidence_kind ?? "");
    if (!fromNodeId || !toNodeId) continue;
    if (edgeKind !== "call" && edgeKind !== "lineage") continue;
    if (evidenceKind !== "exact" && evidenceKind !== "inferred" && evidenceKind !== "gap") continue;
    edges.push({
      from_node_id: fromNodeId,
      to_node_id: toNodeId,
      edge_kind: edgeKind,
      evidence_kind: evidenceKind,
      confidence: toNumber(row.confidence) ?? (evidenceKind === "exact" ? 1 : evidenceKind === "inferred" ? 0.5 : 0),
      trace_id: typeof row.trace_id === "string" ? row.trace_id : undefined,
      at: toNumber(row.event_at) ?? undefined,
    });
  }
  return edges;
}

async function loadEntityEvents(
  filter: EntityEventFilter,
): Promise<EntityEventRow[]> {
  const where = and(
    filter.trace_id ? `trace_id = '${esc(filter.trace_id)}'` : "",
    timeFilter(filter.last_n_minutes),
  );

  const limit = Math.max(100, Math.min(10000, (filter.limit ?? 200) * 10));
  const rows = await query(
    entityEventsViewSql(where || undefined) +
      ` ORDER BY event_at DESC LIMIT ${limit}`,
  );

  const spanIds = [...new Set(rows.map((row) => String(row.span_id ?? "")).filter(Boolean))];
  if (spanIds.length === 0) return [];

  const spans = await query(
    fromSpans(
      `span_id IN (${spanIds.map((id) => `'${esc(id)}'`).join(",")})`,
    ),
  );
  const spanById = new Map<string, SpanRow>(
    spans.map((span) => [String(span.span_id), span]),
  );

  const events: EntityEventRow[] = [];
  for (const row of rows) {
    const spanId = String(row.span_id ?? "");
    const span = spanById.get(spanId);
    if (!span) continue;

    const traceId = String(row.trace_id ?? span.trace_id ?? "");
    const parentIdRaw = span.parent_id;
    const parentId = parentIdRaw && String(parentIdRaw).length > 0
      ? String(parentIdRaw)
      : null;

    events.push({
      action: String(row.action ?? ""),
      entity_type: String(row.entity_type ?? ""),
      entity_id: typeof row.entity_id === "string" && row.entity_id.length > 0
        ? row.entity_id
        : undefined,
      snapshot: typeof row.snapshot === "string" && row.snapshot.length > 0
        ? row.snapshot : null,
      changes: typeof row.changes === "string" && row.changes.length > 0
        ? row.changes : null,
      note: typeof row.note === "string" && row.note.length > 0
        ? row.note : undefined,
      dimensions: parseDimensionsJson(row.dimensions_json),
      at: toNumber(row.event_at) ?? toNumber(span.started_at) ?? Date.now(),
      span_id: spanId,
      trace_id: traceId,
      parent_id: parentId,
      name: String(span.name ?? ""),
      module: String(span.module ?? ""),
      started_at: toNumber(span.started_at) ?? Date.now(),
      duration_ms: toNumber(span.duration_ms),
      has_error: !!(span.error && span.error !== ""),
    });
  }

  return events
    .filter((ev) => !filter.entity_type || ev.entity_type === filter.entity_type)
    .filter((ev) => !filter.entity_id || ev.entity_id === filter.entity_id)
    .filter((ev) => !filter.action || ev.action === filter.action)
    .sort((a, b) => b.at - a.at)
    .slice(0, Math.max(1, Math.min(2000, filter.limit ?? 200)));
}

// ─── Diff Computation ───

function computeSnapshotDiffs(
  events: EntityEventRow[],
  _fieldFilter?: string,
): EntityEventRowWithDiff[] {
  // Group by entity_id to compute per-entity diffs
  const prevByEntity = new Map<string, Record<string, unknown>>();

  return events.map((ev) => {
    const entityKey = ev.entity_id ?? "__no_id__";

    // If the event already has explicit changes (caller-provided diff), use those
    if (ev.changes) {
      try {
        const parsed = JSON.parse(ev.changes);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          // Update prev snapshot for next diff computation
          if (ev.snapshot) {
            try { prevByEntity.set(entityKey, JSON.parse(ev.snapshot)); } catch {}
          }
          return { ...ev, diff: parsed as Record<string, { from: unknown; to: unknown }> };
        }
      } catch {}
    }

    // Compute diff from consecutive snapshots
    if (!ev.snapshot) return { ...ev, diff: null };

    let current: Record<string, unknown>;
    try {
      current = JSON.parse(ev.snapshot);
      if (!current || typeof current !== "object" || Array.isArray(current)) {
        return { ...ev, diff: null };
      }
    } catch {
      return { ...ev, diff: null };
    }

    const prev = prevByEntity.get(entityKey);
    prevByEntity.set(entityKey, current);

    if (!prev) return { ...ev, diff: null };

    // Compute key-by-key diff between prev and current
    const diff: Record<string, { from: unknown; to: unknown }> = {};
    const allKeys = new Set([...Object.keys(prev), ...Object.keys(current)]);
    for (const key of allKeys) {
      const prevVal = prev[key];
      const currVal = current[key];
      if (JSON.stringify(prevVal) !== JSON.stringify(currVal)) {
        diff[key] = { from: prevVal ?? null, to: currVal ?? null };
      }
    }

    return { ...ev, diff: Object.keys(diff).length > 0 ? diff : null };
  });
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

function parseDimensionsJson(
  raw: unknown,
): Record<string, string | number | boolean | null> | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, string | number | boolean | null>;
  } catch {
    return undefined;
  }
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
