import { describe, it, expect } from "vitest";
import type { SpanContext } from "@flightbox/core";
import { extract, inject } from "../src/propagation.js";

describe("propagation (node)", () => {
  it("extract returns undefined outside an active context", () => {
    expect(extract()).toBeUndefined();
  });

  it("inject makes context available within callback and restores afterwards", () => {
    const ctx: SpanContext = { trace_id: "trace-node-1", span_id: "span-node-1" };

    const result = inject(ctx, () => {
      expect(extract()).toBe(ctx);
      return 42;
    });

    expect(result).toBe(42);
    expect(extract()).toBeUndefined();
  });

  it("nested inject restores outer context", () => {
    const outer: SpanContext = { trace_id: "trace-node-2", span_id: "span-node-outer" };
    const inner: SpanContext = { trace_id: "trace-node-2", span_id: "span-node-inner" };

    inject(outer, () => {
      expect(extract()).toBe(outer);

      inject(inner, () => {
        expect(extract()).toBe(inner);
      });

      expect(extract()).toBe(outer);
    });

    expect(extract()).toBeUndefined();
  });

  it("sync throw still restores previous context", () => {
    const ctx: SpanContext = { trace_id: "trace-node-3", span_id: "span-node-3" };

    expect(() => {
      inject(ctx, () => {
        expect(extract()).toBe(ctx);
        throw new Error("node sync boom");
      });
    }).toThrow("node sync boom");

    expect(extract()).toBeUndefined();
  });

  it("async callback keeps context across await", async () => {
    const ctx: SpanContext = { trace_id: "trace-node-4", span_id: "span-node-4" };

    const result = await inject(ctx, async () => {
      expect(extract()).toBe(ctx);
      await Promise.resolve();
      expect(extract()).toBe(ctx);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(extract()).toBeUndefined();
  });

  it("async rejection restores context", async () => {
    const ctx: SpanContext = { trace_id: "trace-node-5", span_id: "span-node-5" };

    await expect(
      inject(ctx, async () => {
        expect(extract()).toBe(ctx);
        await Promise.resolve();
        throw new Error("node async boom");
      }),
    ).rejects.toThrow("node async boom");

    expect(extract()).toBeUndefined();
  });
});
