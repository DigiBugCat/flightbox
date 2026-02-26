import { createTransformer } from "./transform.js";
import { transformSync } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const include = process.env.FLIGHTBOX_INCLUDE?.split(",") ?? undefined;
const exclude = process.env.FLIGHTBOX_EXCLUDE?.split(",") ?? [
  "**/node_modules/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/*.d.ts",
];

const transform = createTransformer({ include, exclude });

// Resolve @flightbox/sdk so injected imports can find it
const require = createRequire(import.meta.url);
let sdkUrl: string | null = null;
try {
  const resolved = require.resolve("@flightbox/sdk");
  const sdkRoot = resolved.replace(/\/(src|dist)\/index\.[jt]s$/, "");
  sdkUrl = pathToFileURL(sdkRoot + "/dist/index.js").href;
} catch {
  // Will be available when published
}

function getLoader(filePath: string): "tsx" | "ts" | "js" {
  if (filePath.endsWith(".tsx")) return "tsx";
  if (filePath.endsWith(".ts")) return "ts";
  return "js";
}

interface ResolveResult {
  url: string;
  format?: string;
  shortCircuit?: boolean;
}

interface ResolveContext {
  parentURL?: string;
  conditions?: string[];
}

type NextResolve = (specifier: string, context: ResolveContext) => Promise<ResolveResult>;

export async function resolve(
  specifier: string,
  context: ResolveContext,
  nextResolve: NextResolve,
): Promise<ResolveResult> {
  if (specifier === "@flightbox/sdk" && sdkUrl) {
    return { url: sdkUrl, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

interface LoadResult {
  source: string | ArrayBuffer | Uint8Array;
  format: string;
  shortCircuit?: boolean;
}

interface LoadContext {
  format?: string;
}

type NextLoad = (url: string, context: LoadContext) => Promise<LoadResult>;

export async function load(
  url: string,
  context: LoadContext,
  nextLoad: NextLoad,
): Promise<LoadResult> {
  if (!url.startsWith("file://")) return nextLoad(url, context);
  if (url.includes("/node_modules/")) return nextLoad(url, context);
  if (!/\.[jt]sx?(\?|$)/.test(url)) return nextLoad(url, context);

  const filePath = fileURLToPath(url);

  let source: string;
  try {
    source = readFileSync(filePath, "utf-8");
  } catch {
    return nextLoad(url, context);
  }

  // Transform handles @flightbox/* exclusion via package.json lookup
  const transformed = transform(source, filePath);
  if (!transformed) return nextLoad(url, context);

  // Strip TypeScript types
  const loader = getLoader(filePath);
  let jsCode = transformed.code;
  if (loader !== "js") {
    const result = transformSync(jsCode, {
      loader,
      format: "esm",
      sourcefile: filePath,
    });
    jsCode = result.code;
  }

  return {
    format: "module",
    source: jsCode,
    shortCircuit: true,
  };
}
