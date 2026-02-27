import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { SpanContext } from "@flightbox/core";

class MockWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  onopen: ((..._args: any[]) => unknown) | null = null;
  onclose: ((..._args: any[]) => unknown) | null = null;
  onerror: ((..._args: any[]) => unknown) | null = null;

  constructor(_url: string) {}

  send(_data: string): void {}
}

type BrowserApi = {
  extract: () => SpanContext | undefined;
  inject: <T>(context: SpanContext, fn: () => T) => T;
};

const previousLocation = (globalThis as any).location;
const previousWebSocket = (globalThis as any).WebSocket;

async function loadBrowserApi(): Promise<BrowserApi> {
  (globalThis as any).location = { protocol: "http:", host: "localhost:5173" };
  (globalThis as any).WebSocket = MockWebSocket;
  const mod = await import("../src/browser.js");
  return { extract: mod.extract, inject: mod.inject };
}

describe("propagation (browser)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    (globalThis as any).location = previousLocation;
    (globalThis as any).WebSocket = previousWebSocket;
  });

  it("extract returns undefined outside an active context", async () => {
    const { extract } = await loadBrowserApi();
    expect(extract()).toBeUndefined();
  });

  it("inject exposes context for sync callback and restores it", async () => {
    const { extract, inject } = await loadBrowserApi();
    const ctx: SpanContext = { trace_id: "trace-browser-1", span_id: "span-browser-1" };

    const result = inject(ctx, () => {
      expect(extract()).toBe(ctx);
      return 123;
    });

    expect(result).toBe(123);
    expect(extract()).toBeUndefined();
  });

  it("inject restores context when sync callback throws", async () => {
    const { extract, inject } = await loadBrowserApi();
    const ctx: SpanContext = { trace_id: "trace-browser-2", span_id: "span-browser-2" };

    expect(() => {
      inject(ctx, () => {
        expect(extract()).toBe(ctx);
        throw new Error("browser sync boom");
      });
    }).toThrow("browser sync boom");

    expect(extract()).toBeUndefined();
  });

  it("inject keeps context across await for async callback", async () => {
    const { extract, inject } = await loadBrowserApi();
    const ctx: SpanContext = { trace_id: "trace-browser-3", span_id: "span-browser-3" };

    const result = await inject(ctx, async () => {
      expect(extract()).toBe(ctx);
      await Promise.resolve();
      expect(extract()).toBe(ctx);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(extract()).toBeUndefined();
  });

  it("inject restores context when async callback rejects and handles nested inject", async () => {
    const { extract, inject } = await loadBrowserApi();
    const outer: SpanContext = { trace_id: "trace-browser-4", span_id: "span-browser-outer" };
    const inner: SpanContext = { trace_id: "trace-browser-4", span_id: "span-browser-inner" };

    inject(outer, () => {
      expect(extract()).toBe(outer);
      inject(inner, () => {
        expect(extract()).toBe(inner);
      });
      expect(extract()).toBe(outer);
    });
    expect(extract()).toBeUndefined();

    await expect(
      inject(outer, async () => {
        expect(extract()).toBe(outer);
        await Promise.resolve();
        throw new Error("browser async boom");
      }),
    ).rejects.toThrow("browser async boom");

    expect(extract()).toBeUndefined();
  });
});
