import { describe, it, expect } from "vitest";
import { serialize } from "../src/serializer.js";

describe("serialize", () => {
  it("returns null for undefined", () => {
    expect(serialize(undefined)).toBe(null);
  });

  it("serializes primitives", () => {
    expect(serialize(42)).toBe("42");
    expect(serialize("hello")).toBe('"hello"');
    expect(serialize(true)).toBe("true");
    expect(serialize(null)).toBe("null");
  });

  it("serializes bigint", () => {
    expect(serialize(BigInt(123))).toBe('"123n"');
  });

  it("serializes Date", () => {
    const d = new Date("2024-01-01T00:00:00Z");
    expect(serialize(d)).toBe('"2024-01-01T00:00:00.000Z"');
  });

  it("serializes RegExp", () => {
    expect(serialize(/abc/gi)).toBe('"/abc/gi"');
  });

  it("serializes Error", () => {
    const err = new Error("test error");
    const parsed = JSON.parse(serialize(err)!);
    expect(parsed.name).toBe("Error");
    expect(parsed.message).toBe("test error");
    expect(parsed.stack).toBeDefined();
  });

  it("serializes functions", () => {
    function myFunc() {}
    expect(serialize(myFunc)).toBe('"<function: myFunc>"');
    const parsed = JSON.parse(serialize(() => {})!);
    expect(parsed).toMatch(/^<function: /);
    expect(parsed).toMatch(/>$/);
  });

  it("serializes arrays", () => {
    expect(serialize([1, 2, 3])).toBe("[1,2,3]");
  });

  it("truncates strings at maxStringLength", () => {
    const long = "x".repeat(600);
    const parsed = JSON.parse(serialize(long)!);
    expect(parsed.length).toBeLessThanOrEqual(515); // 512 + "..."
    expect(parsed.endsWith("...")).toBe(true);
  });

  it("limits array breadth", () => {
    const arr = Array.from({ length: 20 }, (_, i) => i);
    const parsed = JSON.parse(serialize(arr, { maxBreadth: 5 })!);
    expect(parsed).toHaveLength(6); // 5 items + "... 15 more"
    expect(parsed[5]).toBe("... 15 more");
  });

  it("limits object breadth", () => {
    const obj: Record<string, number> = {};
    for (let i = 0; i < 20; i++) obj[`key${i}`] = i;
    const parsed = JSON.parse(serialize(obj, { maxBreadth: 3 })!);
    const keys = Object.keys(parsed);
    expect(keys).toHaveLength(4); // 3 + overflow
  });

  it("limits depth", () => {
    const deep = { a: { b: { c: { d: { e: { f: "deep" } } } } } };
    const parsed = JSON.parse(serialize(deep, { maxDepth: 2 })!);
    expect(parsed.a.b).toBeTypeOf("string"); // collapsed to repr
  });

  it("handles circular references", () => {
    const obj: any = { a: 1 };
    obj.self = obj;
    const parsed = JSON.parse(serialize(obj)!);
    expect(parsed.self).toBe("<circular>");
  });

  it("serializes Map", () => {
    const m = new Map([
      ["a", 1],
      ["b", 2],
    ]);
    const parsed = JSON.parse(serialize(m)!);
    expect(parsed.__type).toBe("Map");
    expect(parsed.a).toBe(1);
  });

  it("serializes Set", () => {
    const s = new Set([1, 2, 3]);
    const parsed = JSON.parse(serialize(s)!);
    expect(parsed.__type).toBe("Set");
    expect(parsed.values).toEqual([1, 2, 3]);
  });

  it("serializes symbols", () => {
    expect(serialize(Symbol("test"))).toBe('"Symbol(test)"');
  });
});
