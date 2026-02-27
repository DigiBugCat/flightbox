import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

const previousLocation = (globalThis as any).location;
const previousWebSocket = (globalThis as any).WebSocket;

describe("lineage helpers (browser)", () => {
  beforeEach(() => {
    vi.resetModules();
    (globalThis as any).location = { protocol: "http:", host: "localhost:5173" };
    (globalThis as any).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    (globalThis as any).location = previousLocation;
    (globalThis as any).WebSocket = previousWebSocket;
  });

  it("withLineage emits metadata when tracked entities are touched", async () => {
    const mod = await import("../src/browser.js");

    mod.configure({
      enabled: true,
      blastScopeId: "scope-browser",
      objectCatalog: { types: ["PAWN"] },
      lineage: { requireBlastScope: true, messageKey: "_fb", maxHops: 2 },
    } as any);

    const wrapped = mod.__flightbox_wrap(
      function sendPawnDelta() {
        mod.trackObjectUpdate("PAWN", "pawn-7", { hp: { from: 10, to: 8 } });
        return mod.withLineage({ kind: "delta" });
      },
      { name: "sendPawnDelta", module: "test.ts", line: 1 },
    );

    const out = wrapped() as Record<string, unknown>;
    const lineage = out._fb as Record<string, unknown>;
    expect(lineage).toBeTruthy();
    expect(lineage.trace_id).toEqual(expect.any(String));
    expect(lineage.span_id).toEqual(expect.any(String));
    expect(lineage.blast_scope_id).toBe("scope-browser");
    expect(lineage.subject_object).toMatchObject({ type: "PAWN", id: "pawn-7" });
  });

  it("runWithLineage injects remote context and restores afterwards", async () => {
    const mod = await import("../src/browser.js");
    mod.configure({ lineage: { requireBlastScope: false, messageKey: "_fb", maxHops: 2 } } as any);

    const payload = {
      _fb: {
        trace_id: "trace-remote",
        span_id: "span-remote",
        subject_object: { type: "PAWN", id: "pawn-2" },
        actor_system: "server#broadcast",
        hop: 0,
        max_hops: 2,
        blast_scope_id: "scope-browser",
      },
    };

    const seen = mod.runWithLineage(payload, () => mod.extract());
    expect(seen).toEqual({ trace_id: "trace-remote", span_id: "span-remote" });
    expect(mod.extract()).toBeUndefined();
  });
});
