import { describe, it, expect } from "vitest";
import { Script, createContext } from "node:vm";
import { transform } from "../src/transform.js";

interface HarnessResult {
  wrapCalls: string[];
  globals: Record<string, unknown>;
}

function runTransformed(source: string): HarnessResult {
  const transformed = transform(source, "src/runtime.js");
  if (!transformed) {
    throw new Error("Expected source to be instrumented");
  }

  const executable = transformed.code.replace(
    /^import\s+\{\s*__flightbox_wrap\s*\}\s+from\s+["']@flightbox\/sdk["'];\n?/,
    "",
  );

  const wrapCalls: string[] = [];
  const sandbox: Record<string, unknown> = {};
  sandbox.__flightbox_wrap = (fn: (...args: unknown[]) => unknown, meta: { name?: string }) => {
    wrapCalls.push(meta?.name ?? "<unknown>");
    return function wrapped(this: unknown, ...args: unknown[]) {
      return fn.apply(this, args);
    };
  };
  sandbox.globalThis = sandbox;

  const context = createContext(sandbox);
  const script = new Script(executable);
  script.runInContext(context);

  return { wrapCalls, globals: sandbox };
}

describe("@flightbox/transform runtime behavior", () => {
  it("wraps function declarations once and reuses cached wrapper", () => {
    const { wrapCalls, globals } = runTransformed(`
function add(a, b) { return a + b; }
globalThis.__fb = { add };
`);
    const add = (globals.__fb as any).add as (a: number, b: number) => number;

    expect(add(1, 2)).toBe(3);
    expect(add(3, 4)).toBe(7);
    expect(add(5, 6)).toBe(11);

    expect(wrapCalls.filter((n) => n === "add")).toHaveLength(1);
  });

  it("wraps class methods once at class init and reuses across instances", () => {
    const { wrapCalls, globals } = runTransformed(`
class Counter {
  inc(n) { return n + 1; }
}
globalThis.__fb = { Counter };
`);
    const Counter = (globals.__fb as any).Counter as new () => { inc: (n: number) => number };

    const a = new Counter();
    const b = new Counter();
    expect(a.inc(1)).toBe(2);
    expect(b.inc(10)).toBe(11);
    expect(a.inc(2)).toBe(3);

    expect(wrapCalls.filter((n) => n === "inc")).toHaveLength(1);
  });

  it("preserves hoisting semantics for function declarations", () => {
    const { globals } = runTransformed(`
const value = callBeforeDeclaration();
function callBeforeDeclaration() { return target(); }
function target() { return 42; }
globalThis.__fb = { value };
`);
    expect((globals.__fb as any).value).toBe(42);
  });

  it("preserves super calls in wrapped class methods", () => {
    const { globals } = runTransformed(`
class A {
  greet() { return "a"; }
}
class B extends A {
  greet() { return super.greet() + "b"; }
}
globalThis.__fb = { B };
`);
    const B = (globals.__fb as any).B as new () => { greet: () => string };
    expect(new B().greet()).toBe("ab");
  });

  it("preserves async and generator function behavior", async () => {
    const { wrapCalls, globals } = runTransformed(`
async function plusOne(n) { return n + 1; }
function* sequence() { yield 1; yield 2; return 3; }
globalThis.__fb = { plusOne, sequence };
`);
    const plusOne = (globals.__fb as any).plusOne as (n: number) => Promise<number>;
    const sequence = (globals.__fb as any).sequence as () => Generator<number, number, unknown>;

    expect(await plusOne(2)).toBe(3);
    expect(await plusOne(9)).toBe(10);
    expect([...sequence()]).toEqual([1, 2]);
    expect([...sequence()]).toEqual([1, 2]);

    expect(wrapCalls.filter((n) => n === "plusOne")).toHaveLength(1);
    expect(wrapCalls.filter((n) => n === "sequence")).toHaveLength(1);
  });
});
