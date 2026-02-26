import { describe, it, expect, beforeEach } from "vitest";

// We test the wrap function in isolation by mocking the buffer
// Since this is a monorepo and types may not resolve without building,
// we test the logic directly

describe("__flightbox_wrap", () => {
  // We need to test the wrap logic. Let's import dynamically.
  // For now, test the core context propagation concept.

  it("wraps synchronous functions", async () => {
    // Import SDK
    const { __flightbox_wrap } = await import("../src/wrap.js");
    const { configure } = await import("../src/config.js");

    configure({ enabled: true });

    function add(a: number, b: number) {
      return a + b;
    }

    const wrapped = __flightbox_wrap(add, {
      name: "add",
      module: "test.ts",
      line: 1,
    });

    const result = wrapped(2, 3);
    expect(result).toBe(5);
  });

  it("wraps async functions", async () => {
    const { __flightbox_wrap } = await import("../src/wrap.js");
    const { configure } = await import("../src/config.js");

    configure({ enabled: true });

    async function fetchData() {
      return { data: "test" };
    }

    const wrapped = __flightbox_wrap(fetchData, {
      name: "fetchData",
      module: "test.ts",
      line: 1,
    });

    const result = await wrapped();
    expect(result).toEqual({ data: "test" });
  });

  it("preserves errors from sync functions", async () => {
    const { __flightbox_wrap } = await import("../src/wrap.js");
    const { configure } = await import("../src/config.js");

    configure({ enabled: true });

    function boom() {
      throw new Error("kaboom");
    }

    const wrapped = __flightbox_wrap(boom, {
      name: "boom",
      module: "test.ts",
      line: 1,
    });

    expect(() => wrapped()).toThrow("kaboom");
  });

  it("preserves errors from async functions", async () => {
    const { __flightbox_wrap } = await import("../src/wrap.js");
    const { configure } = await import("../src/config.js");

    configure({ enabled: true });

    async function asyncBoom() {
      throw new Error("async kaboom");
    }

    const wrapped = __flightbox_wrap(asyncBoom, {
      name: "asyncBoom",
      module: "test.ts",
      line: 1,
    });

    await expect(wrapped()).rejects.toThrow("async kaboom");
  });

  it("passes through when disabled", async () => {
    const { __flightbox_wrap } = await import("../src/wrap.js");
    const { configure } = await import("../src/config.js");

    configure({ enabled: false });

    function identity(x: number) {
      return x;
    }

    const wrapped = __flightbox_wrap(identity, {
      name: "identity",
      module: "test.ts",
      line: 1,
    });

    // When disabled, should return original function
    const result = wrapped(42);
    expect(result).toBe(42);
  });

  it("preserves this binding", async () => {
    const { __flightbox_wrap } = await import("../src/wrap.js");
    const { configure } = await import("../src/config.js");

    configure({ enabled: true });

    const obj = {
      value: 42,
      getValue: __flightbox_wrap(
        function (this: { value: number }) {
          return this.value;
        },
        { name: "getValue", module: "test.ts", line: 1 },
      ),
    };

    expect(obj.getValue()).toBe(42);
  });
});
