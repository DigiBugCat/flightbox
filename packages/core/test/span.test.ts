import { describe, it, expect } from "vitest";
import { createSpan, completeSpan, failSpan } from "../src/span.js";

describe("createSpan", () => {
  it("creates a root span without parent", () => {
    const span = createSpan(
      { name: "test", module: "test.ts", line: 1 },
      undefined,
      [1, 2, 3],
    );

    expect(span.span_id).toBeTruthy();
    expect(span.trace_id).toBeTruthy();
    expect(span.parent_id).toBeNull();
    expect(span.name).toBe("test");
    expect(span.kind).toBe("function");
    expect(span.input).toBe("[1,2,3]");
    expect(span.output).toBeNull();
    expect(span.error).toBeNull();
    expect(span.started_at).toBeGreaterThan(0);
  });

  it("creates a child span with parent context", () => {
    const parent = createSpan(
      { name: "parent", module: "test.ts", line: 1 },
      undefined,
      [],
    );

    const child = createSpan(
      { name: "child", module: "test.ts", line: 5 },
      { trace_id: parent.trace_id, span_id: parent.span_id },
      ["arg"],
    );

    expect(child.trace_id).toBe(parent.trace_id);
    expect(child.parent_id).toBe(parent.span_id);
    expect(child.span_id).not.toBe(parent.span_id);
  });
});

describe("completeSpan", () => {
  it("sets output and timing", () => {
    const span = createSpan(
      { name: "test", module: "test.ts", line: 1 },
      undefined,
      [],
    );

    completeSpan(span, { result: "ok" });

    expect(span.output).toBe('{"result":"ok"}');
    expect(span.ended_at).toBeGreaterThanOrEqual(span.started_at);
    expect(span.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

describe("failSpan", () => {
  it("sets error and timing", () => {
    const span = createSpan(
      { name: "test", module: "test.ts", line: 1 },
      undefined,
      [],
    );

    failSpan(span, new Error("boom"));

    expect(span.error).toBeTruthy();
    const parsed = JSON.parse(span.error!);
    expect(parsed.name).toBe("Error");
    expect(parsed.message).toBe("boom");
    expect(span.ended_at).toBeGreaterThanOrEqual(span.started_at);
  });
});
