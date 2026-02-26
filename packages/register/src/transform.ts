import { Parser } from "acorn";
import { tsPlugin } from "@sveltejs/acorn-typescript";
import { walk } from "estree-walker";
import MagicString from "magic-string";
import picomatch from "picomatch";
import type { Node } from "estree";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { inferName, extractParamNames } from "./names.js";

export interface TransformOptions {
  include?: string[];
  exclude?: string[];
}

export interface TransformResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]>;
}

const TsParser = Parser.extend(tsPlugin());

interface ClassWrapInstruction {
  targetExpr: string;
  keyExpr: string;
  meta: string;
}

interface TransformDebugSample {
  filename: string;
  durationMs: number;
  wrappedNodes: number;
  instrumented: boolean;
}

// Cache: directory path → package name (or null if no package.json found)
const pkgNameCache = new Map<string, string | null>();
const debugTransformEnabled = process.env.FLIGHTBOX_DEBUG_TRANSFORM === "1";
const transformDebugSamples: TransformDebugSample[] = [];
let transformDebugHookInstalled = false;

function ensureTransformDebugHook(): void {
  if (!debugTransformEnabled || transformDebugHookInstalled) return;
  transformDebugHookInstalled = true;

  process.on("exit", () => {
    if (transformDebugSamples.length === 0) return;

    const total = transformDebugSamples.length;
    const instrumented = transformDebugSamples.filter((s) => s.instrumented);
    const totalWrapped = instrumented.reduce((sum, s) => sum + s.wrappedNodes, 0);
    const topSlowest = [...transformDebugSamples]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 10);

    console.log(
      `[flightbox] transform debug: files=${total}, instrumented=${instrumented.length}, wrapped_nodes=${totalWrapped}`,
    );
    if (topSlowest.length > 0) {
      console.log("[flightbox] transform debug: slowest files:");
      for (const sample of topSlowest) {
        console.log(
          `  - ${sample.durationMs.toFixed(2)}ms wraps=${sample.wrappedNodes} ${sample.filename}`,
        );
      }
    }
  });
}

function recordTransformDebug(
  filename: string,
  startedAt: number,
  wrappedNodes: number,
  instrumented: boolean,
): void {
  if (!debugTransformEnabled) return;
  ensureTransformDebugHook();
  transformDebugSamples.push({
    filename,
    durationMs: performance.now() - startedAt,
    wrappedNodes,
    instrumented,
  });
}

/**
 * Find the nearest package.json and return its `name` field.
 * Cached per directory — one readFileSync per package, not per file.
 */
function getPackageName(filePath: string): string | null {
  let dir = dirname(filePath);
  const seen: string[] = [];

  while (dir !== dirname(dir)) { // stop at filesystem root
    if (pkgNameCache.has(dir)) {
      const cached = pkgNameCache.get(dir)!;
      // Backfill cache for intermediate dirs
      for (const d of seen) pkgNameCache.set(d, cached);
      return cached;
    }
    seen.push(dir);

    try {
      const raw = readFileSync(join(dir, "package.json"), "utf-8");
      const name = (JSON.parse(raw) as { name?: string }).name ?? null;
      for (const d of seen) pkgNameCache.set(d, name);
      return name;
    } catch {
      // No package.json here, keep walking up
    }
    dir = dirname(dir);
  }

  // Hit filesystem root with no package.json
  for (const d of seen) pkgNameCache.set(d, null);
  return null;
}

function isFlightboxPackage(filePath: string): boolean {
  const name = getPackageName(filePath);
  return name !== null && name.startsWith("@flightbox/");
}

function buildMeta(name: string, filename: string, line: number): string {
  const escapedName = JSON.stringify(name);
  const escapedModule = JSON.stringify(filename);
  return `{ name: ${escapedName}, module: ${escapedModule}, line: ${line} }`;
}

function isClassNode(node: Node): boolean {
  return node.type === "ClassDeclaration" || node.type === "ClassExpression";
}

function getMethodNameForMeta(md: any): string {
  if (md.key?.type === "Identifier") return md.key.name;
  if (
    md.key?.type === "Literal" &&
    (typeof md.key.value === "string" || typeof md.key.value === "number")
  ) {
    return String(md.key.value);
  }
  return "<computed>";
}

function getEligibleMethodKeyExpr(md: any): string | null {
  if (md.kind !== "method") return null;
  if (md.computed) return null;
  if (md.key?.type === "PrivateIdentifier") return null;

  if (md.key?.type === "Identifier") return JSON.stringify(md.key.name);
  if (
    md.key?.type === "Literal" &&
    (typeof md.key.value === "string" || typeof md.key.value === "number")
  ) {
    return JSON.stringify(md.key.value);
  }

  return null;
}

function buildClassStaticWrapBlock(
  wraps: ClassWrapInstruction[],
): string {
  const lines = wraps.map((w) => [
    `    {`,
    `      const __fb_desc = Object.getOwnPropertyDescriptor(${w.targetExpr}, ${w.keyExpr});`,
    `      if (__fb_desc && typeof __fb_desc.value === "function") {`,
    `        Object.defineProperty(${w.targetExpr}, ${w.keyExpr}, { ...__fb_desc, value: __flightbox_wrap(__fb_desc.value, ${w.meta}) });`,
    "      }",
    "    }",
  ].join("\n"));

  return `\n  static {\n${lines.join("\n")}\n  }\n`;
}

/**
 * Create a reusable transformer with pre-compiled include/exclude matchers.
 */
export function createTransformer(options: TransformOptions = {}) {
  const includeMatcher = options.include
    ? picomatch(options.include, { contains: true })
    : () => true;
  const excludeMatcher = options.exclude
    ? picomatch(options.exclude, { contains: true })
    : () => false;

  return function transform(
    code: string,
    filename: string,
  ): TransformResult | null {
    const debugStart = performance.now();
    let wrappedNodes = 0;

    if (excludeMatcher(filename)) return null;
    if (!includeMatcher(filename)) return null;

    // Skip @flightbox/* packages — check nearest package.json
    if (isFlightboxPackage(filename)) return null;

    let ast: Node;
    try {
      ast = TsParser.parse(code, {
        ecmaVersion: "latest",
        sourceType: "module",
        locations: true,
      }) as unknown as Node;
    } catch {
      // If we can't parse it, skip it
      recordTransformDebug(filename, debugStart, wrappedNodes, false);
      return null;
    }

    const s = new MagicString(code);
    let needsImport = false;
    const classStack: Node[] = [];
    const classWraps = new Map<Node, ClassWrapInstruction[]>();

    walk(ast, {
      enter(node: Node, parent: Node | null) {
        if (isClassNode(node)) {
          classStack.push(node);
        }

        // Skip already-wrapped nodes
        if (
          node.type === "CallExpression" &&
          (node as any).callee?.type === "Identifier" &&
          (node as any).callee?.name === "__flightbox_wrap"
        ) {
          this.skip();
          return;
        }

        const start = (node as any).start as number;
        const end = (node as any).end as number;
        const line = node.loc?.start.line ?? 0;

        if (node.type === "FunctionDeclaration") {
          const id = (node as any).id;
          if (!id) return;
          const name = id.name as string;
          // Never wrap the wrapper itself
          if (name === "__flightbox_wrap") return;
          const meta = buildMeta(name, filename, line);

          // Check if parent is an export
          if (parent?.type === "ExportNamedDeclaration") {
            const exportStart = (parent as any).start as number;
            // export function foo() {} → export const foo = __flightbox_wrap(function foo() {}, meta)
            s.overwrite(exportStart, start, "export const " + name + " = __flightbox_wrap(");
            s.appendLeft(end, ", " + meta + ")");
          } else if (parent?.type === "ExportDefaultDeclaration") {
            const exportStart = (parent as any).start as number;
            // export default function foo() {} → export default __flightbox_wrap(function foo() {}, meta)
            s.overwrite(exportStart, start, "export default __flightbox_wrap(");
            s.appendLeft(end, ", " + meta + ")");
          } else {
            // Preserve hoisting and avoid per-call wrapper construction by caching
            // the wrapped implementation on the function object.
            const funcExpr = (node as any).value ?? node;
            const body = (funcExpr as any).body;
            if (body && body.type === "BlockStatement") {
              const bodyStart = (body as any).start as number;
              const bodyEnd = (body as any).end as number;
              const originalBody = code.slice(bodyStart, bodyEnd);
              const asyncPrefix = (node as any).async ? "async " : "";
              const genPrefix = (node as any).generator ? "*" : "";
              const params = ((node as any).params ?? [])
                .map((p: any) => code.slice((p as any).start as number, (p as any).end as number))
                .join(", ");
              const cacheExpr = `${name}.__flightbox_wrapped`;
              const wrappedExpr =
                `${cacheExpr} || (${cacheExpr} = __flightbox_wrap(${asyncPrefix}function${genPrefix}(${params}) ${originalBody}, ${meta}))`;
              const invoke = (node as any).generator
                ? "return yield* __fb_wrapped.apply(this, arguments);"
                : "return __fb_wrapped.apply(this, arguments);";
              const newBody = `{ const __fb_wrapped = ${wrappedExpr}; ${invoke} }`;
              s.overwrite(bodyStart, bodyEnd, newBody);
            }
          }

          needsImport = true;
          wrappedNodes++;
          this.skip();
          return;
        }

        // Class field arrow functions: handleClick = () => { ... }
        if (node.type === "PropertyDefinition") {
          const pd = node as any;
          const value = pd.value;
          if (
            !value ||
            (value.type !== "ArrowFunctionExpression" &&
              value.type !== "FunctionExpression")
          ) {
            return;
          }

          const keyName =
            pd.key?.type === "Identifier"
              ? pd.key.name
              : "<computed>";
          const meta = buildMeta(keyName, filename, line);

          const valueStart = (value as any).start as number;
          const valueEnd = (value as any).end as number;

          s.prependRight(valueStart, "__flightbox_wrap(");
          s.appendLeft(valueEnd, ", " + meta + ")");

          needsImport = true;
          wrappedNodes++;
          this.skip();
          return;
        }

        if (
          node.type === "ArrowFunctionExpression" ||
          node.type === "FunctionExpression"
        ) {
          // Skip if already inside __flightbox_wrap call
          if (
            parent?.type === "CallExpression" &&
            (parent as any).callee?.type === "Identifier" &&
            (parent as any).callee?.name === "__flightbox_wrap"
          ) {
            return;
          }

          // Skip if this is a class method's value — handled by MethodDefinition
          if (parent?.type === "MethodDefinition") {
            return;
          }

          // Skip if this is a class field's value — handled by PropertyDefinition
          if (parent?.type === "PropertyDefinition") {
            return;
          }

          const name = inferName(node, parent);
          if (name === "__flightbox_wrap") return;
          const meta = buildMeta(name, filename, line);

          s.prependRight(start, "__flightbox_wrap(");
          s.appendLeft(end, ", " + meta + ")");

          needsImport = true;
          wrappedNodes++;
          this.skip();
          return;
        }

        if (node.type === "MethodDefinition") {
          const md = node as any;
          if (md.kind === "constructor") return;

          const keyName = getMethodNameForMeta(md);
          const meta = buildMeta(keyName, filename, line);
          const keyExpr = getEligibleMethodKeyExpr(md);

          if (keyExpr) {
            const classNode = classStack[classStack.length - 1];
            if (classNode) {
              const wraps = classWraps.get(classNode) ?? [];
              wraps.push({
                targetExpr: md.static ? "this" : "this.prototype",
                keyExpr,
                meta,
              });
              classWraps.set(classNode, wraps);
              needsImport = true;
              wrappedNodes++;
              this.skip();
              return;
            }
          }

          const funcExpr = md.value;
          if (!funcExpr || funcExpr.type !== "FunctionExpression") return;

          const body = funcExpr.body;
          if (!body || body.type !== "BlockStatement") return;

          // Get the original body content (between the braces)
          const bodyStart = (body as any).start as number;
          const bodyEnd = (body as any).end as number;
          const originalBody = code.slice(bodyStart, bodyEnd);

          // Filter out TSParameterProperty from params
          const params = (funcExpr.params || []).filter(
            (p: any) => p.type !== "TSParameterProperty",
          );
          const paramNames = extractParamNames(params);

          const asyncPrefix = funcExpr.async ? "async " : "";
          const genPrefix = funcExpr.generator ? "*" : "";

          // Fallback path (private/computed/accessor methods): keep body rewrite.
          const wrappedCall = paramNames
            ? `__flightbox_wrap(${asyncPrefix}function${genPrefix}() ${originalBody}, ${meta}).call(this${paramNames.length ? ", " + paramNames.join(", ") : ""})`
            : `__flightbox_wrap(${asyncPrefix}function${genPrefix}() ${originalBody}, ${meta}).apply(this, arguments)`;
          const invoke = funcExpr.generator
            ? `return yield* ${wrappedCall};`
            : `return ${wrappedCall};`;
          const newBody = `{ ${invoke} }`;

          s.overwrite(bodyStart, bodyEnd, newBody);

          needsImport = true;
          wrappedNodes++;
          this.skip();
          return;
        }
      },
      leave(node: Node) {
        if (!isClassNode(node)) return;

        const wraps = classWraps.get(node);
        if (wraps && wraps.length > 0) {
          const classBody = (node as any).body;
          const insertAt = (classBody.end as number) - 1;
          s.appendLeft(insertAt, buildClassStaticWrapBlock(wraps));
        }

        classStack.pop();
      },
    });

    if (!needsImport) {
      recordTransformDebug(filename, debugStart, wrappedNodes, false);
      return null;
    }

    s.prepend('import { __flightbox_wrap } from "@flightbox/sdk";\n');

    recordTransformDebug(filename, debugStart, wrappedNodes, true);

    return {
      code: s.toString(),
      map: s.generateMap({ source: filename, includeContent: true, hires: true }),
    };
  };
}

/**
 * One-shot transform with default options (include all, exclude nothing).
 */
export function transform(
  code: string,
  filename: string,
  options?: TransformOptions,
): TransformResult | null {
  return createTransformer(options)(code, filename);
}
