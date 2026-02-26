import { describe, it, expect } from "vitest";
import { transformSync } from "@babel/core";
import plugin from "../src/index.js";

function transform(code: string, filename = "src/app.ts"): string {
  const result = transformSync(code, {
    filename,
    plugins: [
      [
        plugin,
        { include: ["src/**/*.ts"], exclude: ["**/*.test.ts"] },
      ],
    ],
    parserOpts: { plugins: ["typescript"] },
  });
  return result?.code ?? "";
}

describe("@flightbox/babel-plugin", () => {
  it("wraps function declarations", () => {
    const output = transform(`function processOrder(order) {
  return order;
}`);
    expect(output).toContain("__flightbox_wrap");
    expect(output).toContain('"processOrder"');
    expect(output).toContain("@flightbox/sdk");
  });

  it("wraps arrow functions assigned to variables", () => {
    const output = transform(`const add = (a, b) => a + b;`);
    expect(output).toContain("__flightbox_wrap");
    expect(output).toContain('"add"');
  });

  it("wraps function expressions", () => {
    const output = transform(
      `const handler = function handleRequest(req) { return req; }`,
    );
    expect(output).toContain("__flightbox_wrap");
    expect(output).toContain('"handler"');
  });

  it("wraps async functions", () => {
    const output = transform(`async function fetchData() {
  return await fetch('/api');
}`);
    expect(output).toContain("__flightbox_wrap");
    expect(output).toContain('"fetchData"');
  });

  it("skips files not matching include pattern", () => {
    const output = transform(
      `function skip() { return 1; }`,
      "lib/other.js",
    );
    expect(output).not.toContain("__flightbox_wrap");
  });

  it("skips test files matching exclude pattern", () => {
    const output = transform(
      `function testHelper() { return 1; }`,
      "src/utils.test.ts",
    );
    expect(output).not.toContain("__flightbox_wrap");
  });

  it("only adds one import per file", () => {
    const output = transform(`
function a() { return 1; }
function b() { return 2; }
`);
    const importCount = (output.match(/@flightbox\/sdk/g) || []).length;
    expect(importCount).toBe(1);
  });

  it("includes file and line metadata", () => {
    const output = transform(`function test() { return 1; }`);
    expect(output).toContain("src/app.ts");
  });
});
