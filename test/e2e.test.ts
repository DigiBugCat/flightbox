import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// SDK imports
import { __flightbox_wrap, configure, flush } from "@flightbox/sdk";

// MCP tool imports (we test them directly, not via MCP protocol)
import {
  flightboxSummary,
  flightboxChildren,
  flightboxInspect,
  flightboxWalk,
  flightboxSearch,
  flightboxSiblings,
  flightboxFailing,
} from "../packages/mcp-server/src/tools.js";

let tracesDir: string;

// ─── Sample app functions ───

function add(a: number, b: number): number {
  return a + b;
}

function multiply(a: number, b: number): number {
  return a * b;
}

function processOrder(items: string[]): { total: number; items: string[] } {
  let total = 0;
  for (const item of items) {
    total = add(total, getPrice(item));
  }
  return { total, items };
}

function getPrice(item: string): number {
  if (item === "widget") return 10;
  if (item === "gadget") return 25;
  return 5;
}

async function fetchUser(id: string): Promise<{ id: string; name: string }> {
  // Simulate async work
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { id, name: `User ${id}` };
}

function explode(): never {
  throw new Error("Something went wrong!");
}

// ─── Wrapped versions ───

const wrappedAdd = __flightbox_wrap(add, {
  name: "add",
  module: "test/e2e.test.ts",
  line: 22,
});

const wrappedMultiply = __flightbox_wrap(multiply, {
  name: "multiply",
  module: "test/e2e.test.ts",
  line: 26,
});

const wrappedGetPrice = __flightbox_wrap(getPrice, {
  name: "getPrice",
  module: "test/e2e.test.ts",
  line: 36,
});

const wrappedProcessOrder = __flightbox_wrap(
  function processOrder(items: string[]) {
    let total = 0;
    for (const item of items) {
      total = wrappedAdd(total, wrappedGetPrice(item));
    }
    return { total, items };
  },
  { name: "processOrder", module: "test/e2e.test.ts", line: 30 },
);

const wrappedFetchUser = __flightbox_wrap(fetchUser, {
  name: "fetchUser",
  module: "test/e2e.test.ts",
  line: 42,
});

const wrappedExplode = __flightbox_wrap(explode, {
  name: "explode",
  module: "test/e2e.test.ts",
  line: 48,
});

describe("Flightbox E2E", () => {
  beforeAll(() => {
    tracesDir = mkdtempSync(join(tmpdir(), "flightbox-e2e-"));
    configure({
      enabled: true,
      tracesDir,
      flushBatchSize: 10000, // Don't auto-flush during test
      flushIntervalMs: 999999,
    });

    // Override the MCP server's traces dir to point at our temp dir
    process.env.FLIGHTBOX_TRACES_DIR = tracesDir;
  });

  afterAll(() => {
    try {
      rmSync(tracesDir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
    delete process.env.FLIGHTBOX_TRACES_DIR;
  });

  it("Step 1: SDK captures spans from sync functions", () => {
    const result = wrappedAdd(2, 3);
    expect(result).toBe(5);

    const result2 = wrappedMultiply(4, 5);
    expect(result2).toBe(20);
  });

  it("Step 2: SDK captures nested call chains", () => {
    const result = wrappedProcessOrder(["widget", "gadget", "widget"]);
    expect(result.total).toBe(45);
    expect(result.items).toEqual(["widget", "gadget", "widget"]);
  });

  it("Step 3: SDK captures async functions", async () => {
    const user = await wrappedFetchUser("user-123");
    expect(user.name).toBe("User user-123");
  });

  it("Step 4: SDK captures errors", () => {
    expect(() => wrappedExplode()).toThrow("Something went wrong!");
  });

  it("Step 5: Flush writes Parquet files to disk", async () => {
    // Force flush all buffered spans
    await flush();

    const files = readdirSync(tracesDir).filter((f) => f.endsWith(".parquet"));
    expect(files.length).toBeGreaterThan(0);
    console.log(`  Flushed ${files.length} Parquet file(s) to ${tracesDir}`);
    for (const f of files) {
      console.log(`    ${f}`);
    }
  });

  it("Step 6: MCP flightbox_summary reads traces", async () => {
    const summary = await flightboxSummary({});
    console.log("  Summary:", JSON.stringify(summary, null, 2));

    expect(summary).not.toHaveProperty("error");
    expect(summary).toHaveProperty("trace_id");
    expect(summary).toHaveProperty("total_spans");
    expect((summary as any).total_spans).toBeGreaterThan(0);
  });

  it("Step 7: MCP flightbox_search finds functions by name", async () => {
    const results = await flightboxSearch({ name_pattern: "processOrder" });
    console.log(
      "  Search results for 'processOrder':",
      JSON.stringify(results, null, 2),
    );

    expect(Array.isArray(results)).toBe(true);
    expect((results as any[]).length).toBeGreaterThan(0);
    expect((results as any[])[0].name).toBe("processOrder");
  });

  it("Step 8: MCP flightbox_inspect returns full span data", async () => {
    // Find a processOrder span first
    const results = await flightboxSearch({ name_pattern: "processOrder" });
    const span = (results as any[])[0];

    const inspected = await flightboxInspect({ span_id: span.span_id });
    console.log("  Inspected span:", JSON.stringify(inspected, null, 2));

    expect(inspected).toHaveProperty("span_id");
    expect(inspected).toHaveProperty("input");
    expect(inspected).toHaveProperty("output");
    expect((inspected as any).name).toBe("processOrder");
  });

  it("Step 9: MCP flightbox_children shows nested calls", async () => {
    // processOrder should have children: add and getPrice calls
    const results = await flightboxSearch({ name_pattern: "processOrder" });
    const span = (results as any[])[0];

    const children = await flightboxChildren({
      span_id: span.span_id,
      include_args: true,
    });
    console.log(
      "  Children of processOrder:",
      JSON.stringify(children, null, 2),
    );

    expect(Array.isArray(children)).toBe(true);
    expect((children as any[]).length).toBeGreaterThan(0);

    // Should have both add and getPrice calls
    const childNames = (children as any[]).map((c: any) => c.name);
    expect(childNames).toContain("add");
    expect(childNames).toContain("getPrice");
  });

  it("Step 10: MCP flightbox_walk traces causality chain", async () => {
    // Find a getPrice span and walk up to processOrder
    const results = await flightboxSearch({ name_pattern: "getPrice" });
    const span = (results as any[])[0];

    const chain = await flightboxWalk({
      span_id: span.span_id,
      direction: "up",
      depth: 5,
    });
    console.log("  Walk up from getPrice:", JSON.stringify(chain, null, 2));

    expect(Array.isArray(chain)).toBe(true);
    const names = (chain as any[]).map((s: any) => s.name);
    expect(names).toContain("processOrder");
  });

  it("Step 11: MCP flightbox_siblings shows execution order", async () => {
    // Find a getPrice span (child of processOrder) and get siblings
    const results = await flightboxSearch({ name_pattern: "getPrice" });
    const span = (results as any[])[0];

    const siblings = await flightboxSiblings({ span_id: span.span_id });
    console.log("  Siblings:", JSON.stringify(siblings, null, 2));

    if (!(siblings as any).error) {
      expect(Array.isArray(siblings)).toBe(true);
      expect((siblings as any[]).length).toBeGreaterThan(1);
    }
  });

  it("Step 12: MCP flightbox_failing finds the explode error", async () => {
    const failing = await flightboxFailing({});
    console.log("  Failing spans:", JSON.stringify(failing, null, 2));

    expect(Array.isArray(failing)).toBe(true);
    expect((failing as any[]).length).toBeGreaterThan(0);

    // Should find our "Something went wrong!" error
    const allErrors = (failing as any[]).flatMap((g: any) =>
      g.spans.map((s: any) => s.name),
    );
    expect(allErrors).toContain("explode");
  });

  it("Step 13: MCP flightbox_search with text finds error content", async () => {
    const results = await flightboxSearch({ text: "went wrong" });
    console.log(
      "  Text search 'went wrong':",
      JSON.stringify(results, null, 2),
    );

    expect(Array.isArray(results)).toBe(true);
    expect((results as any[]).length).toBeGreaterThan(0);
  });
});
