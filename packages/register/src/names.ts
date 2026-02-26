import type { Node } from "estree";

/**
 * Infer a function's name from its parent AST node.
 */
export function inferName(node: Node, parent: Node | null): string {
  // FunctionDeclaration always uses its own id
  if (node.type === "FunctionDeclaration" && (node as any).id) {
    return ((node as any).id as { name: string }).name;
  }

  // For expressions, prefer the parent binding name over the function's own id
  if (parent) {
    // const foo = () => ... / const foo = function named() { ... }
    if (
      parent.type === "VariableDeclarator" &&
      parent.id.type === "Identifier"
    ) {
      return parent.id.name;
    }

    // foo = () => ...
    if (parent.type === "AssignmentExpression") {
      if (parent.left.type === "Identifier") return parent.left.name;
      if (
        parent.left.type === "MemberExpression" &&
        parent.left.property.type === "Identifier"
      ) {
        return parent.left.property.name;
      }
    }

    // { foo: () => ... }
    if (parent.type === "Property" && parent.key.type === "Identifier") {
      return parent.key.name;
    }
  }

  // Fall back to the function's own id (named function expressions)
  if (node.type === "FunctionExpression" && (node as any).id) {
    return ((node as any).id as { name: string }).name;
  }

  return "<anonymous>";
}

/**
 * Extract parameter names from a function's params for .call() delegation.
 * Returns null if any param is a destructured pattern (use `arguments` instead).
 */
export function extractParamNames(params: Node[]): string[] | null {
  const names: string[] = [];
  for (const p of params) {
    if (p.type === "Identifier") {
      names.push(p.name);
    } else if (p.type === "AssignmentPattern" && (p as any).left?.type === "Identifier") {
      names.push((p as any).left.name);
    } else if (p.type === "RestElement" && (p as any).argument?.type === "Identifier") {
      names.push(`...${(p as any).argument.name}`);
    } else if (p.type === "ObjectPattern" || p.type === "ArrayPattern") {
      // Destructured params can't be forwarded by name — signal to use `arguments`
      return null;
    } else if (p.type === "AssignmentPattern" && ((p as any).left?.type === "ObjectPattern" || (p as any).left?.type === "ArrayPattern")) {
      return null;
    } else {
      names.push("undefined");
    }
  }
  return names;
}
