import { Parser } from "acorn";
import { tsPlugin } from "@sveltejs/acorn-typescript";
import { walk } from "estree-walker";
import MagicString from "magic-string";
import picomatch from "picomatch";
import type { Node } from "estree";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

// Cache: directory path → package name (or null if no package.json found)
const pkgNameCache = new Map<string, string | null>();

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
      return null;
    }

    const s = new MagicString(code);
    let needsImport = false;

    walk(ast, {
      enter(node: Node, parent: Node | null) {
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
            // Preserve hoisting: rewrite the body to delegate to a wrapped inner function
            // function foo(a, b) { body } → function foo(a, b) { return __flightbox_wrap(function() { body }, meta).apply(this, arguments); }
            const funcExpr = (node as any).value ?? node;
            const body = (funcExpr as any).body;
            if (body && body.type === "BlockStatement") {
              const bodyStart = (body as any).start as number;
              const bodyEnd = (body as any).end as number;
              const originalBody = code.slice(bodyStart, bodyEnd);
              const asyncPrefix = (node as any).async ? "async " : "";
              const genPrefix = (node as any).generator ? "*" : "";
              const newBody = `{ return __flightbox_wrap(${asyncPrefix}function${genPrefix}() ${originalBody}, ${meta}).apply(this, arguments); }`;
              s.overwrite(bodyStart, bodyEnd, newBody);
            }
          }

          needsImport = true;
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
          this.skip();
          return;
        }

        if (node.type === "MethodDefinition") {
          const md = node as any;
          if (md.kind === "constructor") return;

          const keyName =
            md.key?.type === "Identifier"
              ? md.key.name
              : "<computed>";
          const meta = buildMeta(keyName, filename, line);

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

          // Replace the body with a delegation to __flightbox_wrap
          // If paramNames is null (destructured params), fall back to .apply(this, arguments)
          const newBody = paramNames
            ? `{ return __flightbox_wrap(${asyncPrefix}function${genPrefix}() ${originalBody}, ${meta}).call(this${paramNames.length ? ", " + paramNames.join(", ") : ""}); }`
            : `{ return __flightbox_wrap(${asyncPrefix}function${genPrefix}() ${originalBody}, ${meta}).apply(this, arguments); }`;

          s.overwrite(bodyStart, bodyEnd, newBody);

          needsImport = true;
          this.skip();
          return;
        }
      },
    });

    if (!needsImport) return null;

    s.prepend('import { __flightbox_wrap } from "@flightbox/sdk";\n');

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
