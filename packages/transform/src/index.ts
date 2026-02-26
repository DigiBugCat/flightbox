import { Parser } from "acorn";
import { tsPlugin } from "@sveltejs/acorn-typescript";
import { walk } from "estree-walker";
import MagicString from "magic-string";
import picomatch from "picomatch";
import type { Node } from "estree";
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

    // Skip flightbox SDK internals — files that define or re-export __flightbox_wrap,
    // or files that are part of the @flightbox packages
    if (
      (code.includes("__flightbox_wrap") && (
        code.includes("export function __flightbox_wrap") ||
        code.includes("export { __flightbox_wrap") ||
        code.includes("export const __flightbox_wrap")
      )) ||
      filename.includes("@flightbox/") ||
      filename.includes("@flightbox%2F")
    ) {
      return null;
    }

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
            // function foo() {} → const foo = __flightbox_wrap(function foo() {}, meta)
            s.prependLeft(start, "const " + name + " = __flightbox_wrap(");
            // Remove the declaration keyword range so it becomes an expression
            // Actually we keep the full text — `function foo() {}` in expression position IS a FunctionExpression
            s.appendLeft(end, ", " + meta + ")");
          }

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
          const callArgs = paramNames.join(", ");

          const asyncPrefix = funcExpr.async ? "async " : "";
          const genPrefix = funcExpr.generator ? "*" : "";

          // Replace the body with a delegation to __flightbox_wrap
          const newBody =
            `{ return __flightbox_wrap(${asyncPrefix}function${genPrefix}() ${originalBody}, ${meta}).call(this${callArgs ? ", " + callArgs : ""}); }`;

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
