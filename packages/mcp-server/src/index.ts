#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  summarySchema,
  childrenSchema,
  inspectSchema,
  walkSchema,
  searchSchema,
  recentSchema,
  siblingsSchema,
  failingSchema,
  entitiesSchema,
  entityTimelineSchema,
  querySchema,
  flightboxSummary,
  flightboxChildren,
  flightboxInspect,
  flightboxWalk,
  flightboxSearch,
  flightboxRecent,
  flightboxSiblings,
  flightboxFailing,
  flightboxEntities,
  flightboxEntityTimeline,
  flightboxQuery,
} from "./tools.js";

const server = new McpServer({
  name: "flightbox",
  version: "0.0.1",
});

server.tool(
  "flightbox_summary",
  "Entry point for debugging. Returns trace overview with root span, total spans, duration, slowest spans, and errors.",
  summarySchema.shape,
  async (params) => ({
    content: [
      { type: "text", text: JSON.stringify(await flightboxSummary(params), null, 2) },
    ],
  }),
);

server.tool(
  "flightbox_children",
  "Drill into a span's children. Returns child spans with name, duration, error status.",
  childrenSchema.shape,
  async (params) => ({
    content: [
      { type: "text", text: JSON.stringify(await flightboxChildren(params), null, 2) },
    ],
  }),
);

server.tool(
  "flightbox_inspect",
  "Full detail on one span. Returns complete span data including serialized input/output/error.",
  inspectSchema.shape,
  async (params) => ({
    content: [
      { type: "text", text: JSON.stringify(await flightboxInspect(params), null, 2) },
    ],
  }),
);

server.tool(
  "flightbox_walk",
  "Walk ancestors or descendants of a span. Returns ordered chain of spans (skeleton: name, duration, has_error).",
  walkSchema.shape,
  async (params) => ({
    content: [
      { type: "text", text: JSON.stringify(await flightboxWalk(params), null, 2) },
    ],
  }),
);

server.tool(
  "flightbox_search",
  "Full-text + structural search across spans. Filter by text, name pattern, error status, duration, ancestry, trace, or time.",
  searchSchema.shape,
  async (params) => ({
    content: [
      { type: "text", text: JSON.stringify(await flightboxSearch(params), null, 2) },
    ],
  }),
);

server.tool(
  "flightbox_recent",
  "Polling-friendly incremental feed for runtime inspectors. Returns spans ordered by time since a cursor (since_started_at + since_span_id).",
  recentSchema.shape,
  async (params) => ({
    content: [
      { type: "text", text: JSON.stringify(await flightboxRecent(params), null, 2) },
    ],
  }),
);

server.tool(
  "flightbox_siblings",
  "Everything that ran under the same parent, in execution order.",
  siblingsSchema.shape,
  async (params) => ({
    content: [
      { type: "text", text: JSON.stringify(await flightboxSiblings(params), null, 2) },
    ],
  }),
);

server.tool(
  "flightbox_failing",
  "Find recent errors. Returns traces with errors grouped by error type.",
  failingSchema.shape,
  async (params) => ({
    content: [
      { type: "text", text: JSON.stringify(await flightboxFailing(params), null, 2) },
    ],
  }),
);

server.tool(
  "flightbox_entities",
  "Summarize tracked entity activity by type/id. Use this to see created/updated/deleted entities (for example PAWN) over time windows.",
  entitiesSchema.shape,
  async (params) => ({
    content: [
      { type: "text", text: JSON.stringify(await flightboxEntities(params), null, 2) },
    ],
  }),
);

server.tool(
  "flightbox_entity_timeline",
  "Timeline for one entity type (and optional id), including span anchors so you can walk the call graph around each entity mutation. " +
  "Returns snapshot data and computed diffs between consecutive snapshots. " +
  "Use field_filter to narrow to events where a specific field changed (e.g. 'position', 'state').",
  entityTimelineSchema.shape,
  async (params) => ({
    content: [
      { type: "text", text: JSON.stringify(await flightboxEntityTimeline(params), null, 2) },
    ],
  }),
);

server.tool(
  "flightbox_query",
  "Run arbitrary DuckDB SQL against the spans table. Use `spans` as the table name. " +
  "Supports JSON_EXTRACT_STRING(input, '$.path') for digging into serialized args/returns/context, " +
  "aggregations, window functions, CTEs — full DuckDB SQL. " +
  "Use this for ad-hoc analysis like grouping by extracted fields, finding hot paths, " +
  "comparing entity performance, etc.",
  querySchema.shape,
  async (params) => ({
    content: [
      { type: "text", text: JSON.stringify(await flightboxQuery(params), null, 2) },
    ],
  }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Flightbox MCP server error:", err);
  process.exit(1);
});
