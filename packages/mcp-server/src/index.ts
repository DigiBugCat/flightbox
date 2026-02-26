#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  summarySchema,
  childrenSchema,
  inspectSchema,
  walkSchema,
  searchSchema,
  siblingsSchema,
  failingSchema,
  flightboxSummary,
  flightboxChildren,
  flightboxInspect,
  flightboxWalk,
  flightboxSearch,
  flightboxSiblings,
  flightboxFailing,
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Flightbox MCP server error:", err);
  process.exit(1);
});
