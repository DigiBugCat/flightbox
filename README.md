# Flightbox

Passive causality tracing for dev-time debugging.

## The problem

You ask an LLM to build a feature. It writes code across several files — handlers, services, utilities. Something breaks. Now what?

You didn't write the code, so you don't have a mental model of it. You can't just "think through" where the bug is. You paste the error back to the LLM, it guesses, you go back and forth. Maybe it fixes it, maybe it makes it worse.

The issue isn't that the LLM can't debug — it's that it can't *see*. It wrote the code but has no idea what actually happened at runtime. What got called, with what arguments, what came back, where it blew up.

## What Flightbox does

Flightbox records function execution — arguments, return values, errors, timing, and parent-child relationships — and writes it to Parquet files. An MCP server reads those files and exposes tools that let an LLM walk the execution trace.

No reproduction needed. The LLM doesn't have to guess what happened. It can look.

```
Your app (instrumented)          Claude / any MCP client
  │                                │
  │ functions run normally         │ "why did checkout fail?"
  │ spans get recorded             │
  │                                │ calls flightbox_failing
  ▼                                │ → finds the error span
~/.flightbox/traces/*.parquet      │ calls flightbox_walk
  │                                │ → traces up to the root cause
  │         DuckDB reads ──────────│ calls flightbox_inspect
  │                                │ → sees the bad input
  │                                ▼
  │                              "the shipping calculator got
  │                               null instead of an address
  │                               because fetchUser returned
  │                               early on line 42"
```

There's no daemon. The SDK writes Parquet files to a directory. The MCP server reads them with DuckDB. They never talk to each other — they share a filesystem.

## Quick start

### 1. Instrument your app

**Option A: Loader hook (recommended)** — works with tsx, ts-node, plain node. Zero config.

```bash
npm install @flightbox/register @flightbox/sdk
node --import @flightbox/register ./src/index.ts
```

Or with tsx:
```bash
tsx --import @flightbox/register ./src/index.ts
```

Every function in your code gets instrumented automatically. No Babel, no build config.

**Option B: Build plugin** — works with Vite, webpack, esbuild, Rollup.

```bash
npm install @flightbox/unplugin @flightbox/sdk
```

```js
// vite.config.ts
import flightbox from '@flightbox/unplugin/vite'
export default { plugins: [flightbox()] }
```

**Option C: Babel plugin** — if you already use Babel.

```js
// babel.config.js
plugins: [
  ["@flightbox/babel-plugin", {
    include: ["src/**/*.ts"],
    exclude: ["**/*.test.ts"],
  }]
]
```

### 2. Add the MCP server

```json
{
  "mcpServers": {
    "flightbox": {
      "command": "npx",
      "args": ["@flightbox/mcp-server"]
    }
  }
}
```

### 3. Run your app, then ask questions

Run your app normally. When something breaks, ask the LLM:

> "Why did checkout fail?"

It will use the MCP tools to find the error, trace the call chain, and inspect the arguments that caused the problem.

## How it works

The instrumentation turns this:

```js
function processOrder(order) {
  const validated = validate(order)
  return charge(validated)
}
```

Into (roughly):

```js
import { __flightbox_wrap } from '@flightbox/sdk'

const processOrder = __flightbox_wrap(
  function processOrder(order) {
    const validated = validate(order)
    return charge(validated)
  },
  { name: "processOrder", module: "src/orders.ts", line: 1 }
)
```

**`@flightbox/sdk`** — The runtime. `__flightbox_wrap` records a span for each function call — what went in, what came out (or what error was thrown), how long it took, and who the parent was. Uses `AsyncLocalStorage` for context propagation so nested calls form a tree. Buffers spans in memory and flushes to Parquet periodically or on process exit. Auto-starts on import — no bootstrap needed.

**`@flightbox/mcp-server`** — Exposes 7 tools over MCP:

| Tool | What it does |
|------|-------------|
| `flightbox_summary` | Entry point. Shows trace overview — root span, total spans, slowest, errors. |
| `flightbox_children` | Drill into a span's children. What did this function call? |
| `flightbox_inspect` | Full detail on one span — serialized args, return value, error + stack. |
| `flightbox_walk` | Walk up or down the call tree from any span. |
| `flightbox_search` | Find spans by function name, text in args/output/errors, duration, etc. |
| `flightbox_siblings` | Everything that ran under the same parent, in execution order. |
| `flightbox_failing` | Recent errors, grouped by error type. |

## Configuration

The loader hook and unplugin work with zero config by default. To customize:

**Loader hook** — env vars:
```bash
FLIGHTBOX_INCLUDE="src/**/*.ts" FLIGHTBOX_EXCLUDE="**/*.test.ts" node --import @flightbox/register ./app.ts
```

**Unplugin** — options:
```js
flightbox({ include: ["src/**/*.ts"], exclude: ["**/*.test.ts"] })
```

**SDK** — optional, for advanced use:
```ts
import { configure } from '@flightbox/sdk'

configure({
  enabled: true,
  tracesDir: '~/.flightbox/traces',
  flushIntervalMs: 5000,
})
```

## Packages

| Package | What | npm |
|---------|------|-----|
| `@flightbox/register` | Node.js loader hook | [![npm](https://img.shields.io/npm/v/@flightbox/register)](https://www.npmjs.com/package/@flightbox/register) |
| `@flightbox/unplugin` | Build plugin (Vite/webpack/esbuild/Rollup) | [![npm](https://img.shields.io/npm/v/@flightbox/unplugin)](https://www.npmjs.com/package/@flightbox/unplugin) |
| `@flightbox/sdk` | Runtime SDK | [![npm](https://img.shields.io/npm/v/@flightbox/sdk)](https://www.npmjs.com/package/@flightbox/sdk) |
| `@flightbox/transform` | Shared AST transform | [![npm](https://img.shields.io/npm/v/@flightbox/transform)](https://www.npmjs.com/package/@flightbox/transform) |
| `@flightbox/mcp-server` | MCP query tools | [![npm](https://img.shields.io/npm/v/@flightbox/mcp-server)](https://www.npmjs.com/package/@flightbox/mcp-server) |
| `@flightbox/core` | Shared types & serializer | [![npm](https://img.shields.io/npm/v/@flightbox/core)](https://www.npmjs.com/package/@flightbox/core) |
| `@flightbox/babel-plugin` | Babel transform (legacy) | [![npm](https://img.shields.io/npm/v/@flightbox/babel-plugin)](https://www.npmjs.com/package/@flightbox/babel-plugin) |

## What gets captured

Each function call produces a span:

- **span_id / trace_id / parent_id** — the DAG structure
- **name, module, file_line** — where in your code
- **input** — JSON-serialized arguments (depth-limited, truncated)
- **output** — JSON-serialized return value
- **error** — JSON-serialized error with stack trace
- **started_at / ended_at / duration_ms** — timing
- **git_sha** — which commit

Serialization is depth-limited (5 levels), breadth-limited (10 items per object/array), and string-truncated (512 chars). Circular references are detected. The goal is capturing enough for an LLM to reason about, not perfect fidelity.

## License

MIT
