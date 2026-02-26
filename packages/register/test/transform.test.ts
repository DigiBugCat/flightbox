import { describe, it, expect } from "vitest";
import { transform } from "../src/transform.js";

function t(code: string, filename = "src/app.ts"): string {
  const result = transform(code, filename);
  return result?.code ?? code;
}

describe("@flightbox/transform", () => {
  it("wraps function declarations", () => {
    const output = t(`function processOrder(order) {
  return order;
}`);
    expect(output).toContain("__flightbox_wrap");
    expect(output).toContain('"processOrder"');
    expect(output).toContain("@flightbox/sdk");
  });

  it("wraps arrow functions assigned to variables", () => {
    const output = t(`const add = (a, b) => a + b;`);
    expect(output).toContain("__flightbox_wrap");
    expect(output).toContain('"add"');
  });

  it("wraps function expressions", () => {
    const output = t(
      `const handler = function handleRequest(req) { return req; }`,
    );
    expect(output).toContain("__flightbox_wrap");
    expect(output).toContain('"handler"');
  });

  it("wraps async functions", () => {
    const output = t(`async function fetchData() {
  return await fetch('/api');
}`);
    expect(output).toContain("__flightbox_wrap");
    expect(output).toContain('"fetchData"');
  });

  it("skips files not matching include pattern", () => {
    const result = transform(
      `function skip() { return 1; }`,
      "lib/other.js",
      { include: ["src/**/*.ts"] },
    );
    expect(result).toBeNull();
  });

  it("skips files matching exclude pattern", () => {
    const result = transform(
      `function testHelper() { return 1; }`,
      "src/utils.test.ts",
      { exclude: ["**/*.test.ts"] },
    );
    expect(result).toBeNull();
  });

  it("only adds one import per file", () => {
    const output = t(`
function a() { return 1; }
function b() { return 2; }
`);
    const importCount = (output.match(/@flightbox\/sdk/g) || []).length;
    expect(importCount).toBe(1);
  });

  it("includes file and line metadata", () => {
    const output = t(`function test() { return 1; }`);
    expect(output).toContain("src/app.ts");
  });

  it("handles export function declarations", () => {
    const output = t(`export function foo() { return 1; }`);
    expect(output).toContain("export const foo = __flightbox_wrap(");
    expect(output).not.toContain("export function");
  });

  it("handles export default function declarations", () => {
    const output = t(`export default function bar() { return 2; }`);
    expect(output).toContain("export default __flightbox_wrap(");
  });

  it("wraps class methods but skips constructors", () => {
    const output = t(`class Foo {
  constructor() {}
  doWork(x) { return x * 2; }
}`);
    expect(output).toContain("__flightbox_wrap");
    expect(output).toContain('"doWork"');
    // constructor body should not be wrapped
    const wrapCount = (output.match(/__flightbox_wrap/g) || []).length;
    // One for the import, one for doWork
    expect(wrapCount).toBe(2);
  });

  it("does not double-wrap already wrapped functions", () => {
    const output = t(
      `const fn = __flightbox_wrap(() => 1, { name: "fn", module: "x", line: 1 });`,
    );
    // Should not add another wrap
    const wrapCount = (output.match(/__flightbox_wrap/g) || []).length;
    expect(wrapCount).toBe(1);
  });

  it("returns null when no functions are found", () => {
    const result = transform(`const x = 1; const y = 2;`, "src/app.ts");
    expect(result).toBeNull();
  });

  it("handles TypeScript syntax", () => {
    const output = t(`function greet(name: string): string {
  return \`Hello \${name}\`;
}`);
    expect(output).toContain("__flightbox_wrap");
    expect(output).toContain('"greet"');
  });

  it("preserves function declaration hoisting", () => {
    const output = t(`function foo() { return 1; }`);
    // Should remain a function declaration (hoisted), not become const
    expect(output).toContain("function foo()");
    expect(output).not.toContain("const foo");
    expect(output).toContain("__flightbox_wrap");
    expect(output).toContain(".apply(this, arguments)");
  });

  it("handles class methods with destructured params", () => {
    const output = t(`class Svc {
  update({ id, name }) { return id; }
}`);
    expect(output).toContain("__flightbox_wrap");
    // Should fall back to .apply(this, arguments) for destructured params
    expect(output).toContain(".apply(this, arguments)");
  });

  it("handles generator methods", () => {
    const output = t(`class Iter {
  *items() { yield 1; yield 2; }
}`);
    expect(output).toContain("__flightbox_wrap");
    expect(output).toContain("function*()");
  });

  it("wraps class field arrow functions", () => {
    const output = t(`class App {
  handleClick = (e) => { console.log(e); }
}`);
    expect(output).toContain("__flightbox_wrap");
    expect(output).toContain('"handleClick"');
  });

  it("wraps class field function expressions", () => {
    const output = t(`class App {
  process = function(data) { return data; }
}`);
    expect(output).toContain("__flightbox_wrap");
    expect(output).toContain('"process"');
  });

  it("does not wrap class fields that are not functions", () => {
    const output = t(`class App {
  count = 0;
  name = "test";
}`);
    expect(output).not.toContain("__flightbox_wrap");
  });
});
