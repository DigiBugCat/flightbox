import { describe, it, expect, vi, beforeEach } from "vitest";

describe("lineage helpers (node)", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("withLineage emits metadata when tracked entities are touched", async () => {
    const { __flightbox_wrap } = await import("../src/wrap.js");
    const { configure } = await import("../src/config.js");
    const { trackEntityUpdate } = await import("../src/entity.js");
    const { withLineage } = await import("../src/lineage.js");

    configure({
      enabled: true,
      blastScopeId: "scope-node",
      entityCatalog: { types: ["PAWN"] },
      lineage: { requireBlastScope: true, messageKey: "_fb", maxHops: 2 },
    });

    const wrapped = __flightbox_wrap(
      function sendPawnDelta() {
        trackEntityUpdate("PAWN", "pawn-1", { hp: { from: 10, to: 7 } });
        return withLineage({ kind: "delta" });
      },
      { name: "sendPawnDelta", module: "test.ts", line: 1 },
    );

    const out = wrapped() as Record<string, unknown>;
    const lineage = out._fb as Record<string, unknown>;
    expect(lineage).toBeTruthy();
    expect(lineage.trace_id).toEqual(expect.any(String));
    expect(lineage.span_id).toEqual(expect.any(String));
    expect(lineage.blast_scope_id).toBe("scope-node");
    expect(lineage.subject_entity).toMatchObject({ type: "PAWN", id: "pawn-1" });
  });

  it("withLineage is a no-op when no tracked entity was touched", async () => {
    const { __flightbox_wrap } = await import("../src/wrap.js");
    const { configure } = await import("../src/config.js");
    const { withLineage } = await import("../src/lineage.js");

    configure({
      enabled: true,
      blastScopeId: "scope-node",
      entityCatalog: { types: ["PAWN"] },
      lineage: { requireBlastScope: true, messageKey: "_fb", maxHops: 2 },
    });

    const wrapped = __flightbox_wrap(
      function sendWithoutEntity() {
        return withLineage({ kind: "delta" });
      },
      { name: "sendWithoutEntity", module: "test.ts", line: 1 },
    );

    expect(wrapped()).toEqual({ kind: "delta" });
  });

  it("runWithLineage injects remote context and restores afterwards", async () => {
    const { extract } = await import("../src/propagation.js");
    const { runWithLineage } = await import("../src/lineage.js");
    const { configure } = await import("../src/config.js");

    configure({
      enabled: true,
      lineage: { requireBlastScope: false, messageKey: "_fb", maxHops: 2 },
    });

    const payload = {
      _fb: {
        trace_id: "trace-remote",
        span_id: "span-remote",
        subject_entity: { type: "PAWN", id: "pawn-2" },
        actor_system: "server#broadcast",
        hop: 0,
        max_hops: 2,
        blast_scope_id: "scope-node",
      },
    };

    const seen = runWithLineage(payload, () => extract());
    expect(seen).toEqual({ trace_id: "trace-remote", span_id: "span-remote" });
    expect(extract()).toBeUndefined();
  });
});
