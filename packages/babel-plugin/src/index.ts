import type { PluginObj, PluginPass, NodePath, types as BabelTypes } from "@babel/core";
import picomatch from "picomatch";

interface PluginOptions {
  include?: string[];
  exclude?: string[];
}

interface PluginState extends PluginPass {
  flightboxImported?: boolean;
  shouldInstrument?: boolean;
}

export default function flightboxBabelPlugin(
  { types: t }: { types: typeof BabelTypes },
  options: PluginOptions,
): PluginObj<PluginState> {
  const includeMatcher = options.include
    ? picomatch(options.include, { contains: true })
    : () => true;
  const excludeMatcher = options.exclude
    ? picomatch(options.exclude, { contains: true })
    : () => false;

  function shouldInstrumentFile(filename: string | undefined): boolean {
    if (!filename) return false;
    // Babel provides absolute paths; test against both absolute and basename
    if (excludeMatcher(filename)) return false;
    return includeMatcher(filename);
  }

  function ensureImport(
    path: NodePath<BabelTypes.Program>,
    state: PluginState,
  ): void {
    if (state.flightboxImported) return;
    state.flightboxImported = true;

    const importDecl = t.importDeclaration(
      [
        t.importSpecifier(
          t.identifier("__flightbox_wrap"),
          t.identifier("__flightbox_wrap"),
        ),
      ],
      t.stringLiteral("@flightbox/sdk"),
    );

    path.unshiftContainer("body", importDecl);
  }

  function buildWrapCall(
    fn: BabelTypes.Expression,
    name: string,
    filename: string | undefined,
    line: number | undefined,
  ): BabelTypes.CallExpression {
    return t.callExpression(t.identifier("__flightbox_wrap"), [
      fn,
      t.objectExpression([
        t.objectProperty(t.identifier("name"), t.stringLiteral(name)),
        t.objectProperty(
          t.identifier("module"),
          t.stringLiteral(filename ?? "unknown"),
        ),
        t.objectProperty(
          t.identifier("line"),
          t.numericLiteral(line ?? 0),
        ),
      ]),
    ]);
  }

  function getFunctionName(path: NodePath<BabelTypes.Function>): string {
    const parent = path.parentPath;
    if (parent?.isVariableDeclarator()) {
      const id = parent.node.id;
      if (t.isIdentifier(id)) return id.name;
    }
    if (parent?.isAssignmentExpression()) {
      const left = parent.node.left;
      if (t.isIdentifier(left)) return left.name;
      if (
        t.isMemberExpression(left) &&
        t.isIdentifier(left.property)
      ) {
        return left.property.name;
      }
    }
    if (
      (path.isFunctionExpression() || path.isFunctionDeclaration()) &&
      path.node.id
    ) {
      return path.node.id.name;
    }
    return "<anonymous>";
  }

  return {
    name: "flightbox",
    visitor: {
      Program: {
        enter(_path, state) {
          state.shouldInstrument = shouldInstrumentFile(state.filename);
        },
      },

      FunctionDeclaration(path, state) {
        if (!state.shouldInstrument) return;
        if (!path.node.id) return;

        const name = path.node.id.name;
        const line = path.node.loc?.start.line;
        const programPath = path.findParent((p) =>
          p.isProgram(),
        ) as NodePath<BabelTypes.Program>;
        ensureImport(programPath, state);

        const funcExpr = t.functionExpression(
          path.node.id,
          path.node.params,
          path.node.body,
          path.node.generator,
          path.node.async,
        );

        const wrapped = buildWrapCall(funcExpr, name, state.filename, line);
        const varDecl = t.variableDeclaration("const", [
          t.variableDeclarator(t.identifier(name), wrapped),
        ]);

        path.replaceWith(varDecl);
      },

      "ArrowFunctionExpression|FunctionExpression"(
        path: NodePath<
          BabelTypes.ArrowFunctionExpression | BabelTypes.FunctionExpression
        >,
        state: PluginState,
      ) {
        if (!state.shouldInstrument) return;

        // Skip if already wrapped
        if (
          path.parentPath?.isCallExpression() &&
          t.isIdentifier(path.parentPath.node.callee, {
            name: "__flightbox_wrap",
          })
        ) {
          return;
        }

        const name = getFunctionName(path as NodePath<BabelTypes.Function>);
        const line = path.node.loc?.start.line;
        const programPath = path.findParent((p) =>
          p.isProgram(),
        ) as NodePath<BabelTypes.Program>;
        ensureImport(programPath, state);

        const wrapped = buildWrapCall(
          path.node,
          name,
          state.filename,
          line,
        );

        path.replaceWith(wrapped);
        path.skip();
      },

      ClassMethod(path, state) {
        if (!state.shouldInstrument) return;
        if (path.node.kind === "constructor") return;

        const name = t.isIdentifier(path.node.key)
          ? path.node.key.name
          : "<computed>";
        const line = path.node.loc?.start.line;
        const programPath = path.findParent((p) =>
          p.isProgram(),
        ) as NodePath<BabelTypes.Program>;
        ensureImport(programPath, state);

        const funcExpr = t.functionExpression(
          null,
          path.node.params,
          path.node.body,
          path.node.generator,
          path.node.async,
        );

        const wrapped = buildWrapCall(funcExpr, name, state.filename, line);

        // Build args list from params
        const args: BabelTypes.Expression[] = path.node.params.map((p) => {
          if (t.isIdentifier(p)) return t.cloneNode(p);
          if (t.isAssignmentPattern(p) && t.isIdentifier(p.left))
            return t.cloneNode(p.left);
          if (t.isRestElement(p) && t.isIdentifier(p.argument))
            return t.spreadElement(t.cloneNode(p.argument)) as unknown as BabelTypes.Expression;
          return t.identifier("undefined");
        });

        const callExpr = t.callExpression(
          t.memberExpression(wrapped, t.identifier("call")),
          [t.thisExpression(), ...args],
        );

        path.node.body = t.blockStatement([
          t.returnStatement(callExpr),
        ]);
      },
    },
  };
}
