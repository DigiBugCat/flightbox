# Flightbox

Passive causality tracing for dev-time debugging.

## The problem

You ask an LLM to build a feature. It writes code across several files — handlers, services, utilities. Something breaks. Now what?

You didn't write the code, so you don't have a mental model of it. You can't just "think through" where the bug is. You paste the error back to the LLM, it guesses, you go back and forth. Maybe it fixes it, maybe it makes it worse.

The issue isn't that the LLM can't debug — it's that it can't *see*. It wrote the code but has no idea what actually happened at runtime. What got called, with what arguments, what came back, where it blew up.

## What Flightbox does

Flightbox records function execution — arguments, return values, errors, timing, parent-child relationships, and object state — then writes it to Parquet files. An MCP server reads those files and exposes tools that let an LLM walk the execution trace.

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

**Option A: Loader hook (Node.js, recommended)** — works with tsx, ts-node, plain node. Zero config.

```bash
npm install @flightbox/register @flightbox/sdk
node --import @flightbox/register ./src/index.ts
```

Or with tsx:
```bash
tsx --import @flightbox/register ./src/index.ts
```

Every function in your code gets instrumented automatically. No Babel, no build config.

**Option B: Vite plugin (browser + Node)** — auto-instruments your code and captures browser traces via WebSocket.

```bash
npm install @flightbox/unplugin @flightbox/sdk
```

```ts
// vite.config.ts
import flightbox from '@flightbox/unplugin/vite'

export default {
  plugins: [flightbox()],
}
```

This does four things:
1. **Scopes** instrumentation to recently changed files via `git diff` — only traces code in your blast radius
2. **Transforms** those files to wrap functions with tracing
3. **Aliases** `@flightbox/sdk` → `@flightbox/sdk/browser` so the browser gets a lightweight SDK
4. **Starts a WebSocket collector** on the Vite dev server that writes browser spans to Parquet

You can also add explicit includes alongside the git-based scoping:

```ts
flightbox({ include: ['**/renderer/**'] })
```

Browser spans use `requestIdleCallback` to batch and send traces during idle time — no frame drops even at 60fps with hundreds of entities.

**Option C: Other bundlers** — webpack, esbuild, Rollup (transform only, no browser collection).

```bash
npm install @flightbox/unplugin @flightbox/sdk
```

```js
// webpack
import flightbox from '@flightbox/unplugin/webpack'
// esbuild
import flightbox from '@flightbox/unplugin/esbuild'
// rollup
import flightbox from '@flightbox/unplugin/rollup'
```

**Option D: Babel plugin** — if you already use Babel.

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

### Node.js

**`@flightbox/sdk`** — The runtime. `__flightbox_wrap` records a span for each function call — what went in, what came out (or what error was thrown), how long it took, and who the parent was. Uses `AsyncLocalStorage` for context propagation so nested calls form a tree. Buffers spans in memory and flushes to Parquet periodically or on process exit. Auto-starts on import — no bootstrap needed.

### Browser

**`@flightbox/sdk/browser`** — Same `__flightbox_wrap` interface but browser-compatible. Uses an array-based call stack instead of `AsyncLocalStorage` (browser JS is single-threaded). Batches spans and sends them as JSON over WebSocket during `requestIdleCallback` — never during a frame.

The Vite plugin receives these spans on the dev server and writes them to the same `~/.flightbox/traces/` directory as Node spans. The MCP server reads them identically — it doesn't know or care whether a span came from Node or a browser.

```
Browser (main thread)              Vite dev server            MCP server
  │                                    │                         │
  │ wrapped fn runs → span recorded    │                         │
  │ buffer.push(span)                  │                         │
  │   ...more functions...             │                         │
  │ requestIdleCallback fires          │                         │
  │   JSON.stringify(batch)            │                         │
  │   ws.send(json) ──────────────────→│ JSON.parse              │
  │                                    │ batch append (DuckDB)   │
  │                                    │ every 500ms:            │
  │                                    │   flush → .parquet      │
  │                                    │   ~/.flightbox/traces/  │──→ queries
```

## MCP tools

**`@flightbox/mcp-server`** — Exposes 11 tools over MCP:

| Tool | What it does |
|------|-------------|
| `flightbox_summary` | Entry point. Shows trace overview — root span, total spans, slowest, errors. |
| `flightbox_children` | Drill into a span's children. What did this function call? |
| `flightbox_inspect` | Full detail on one span — serialized args, return value, error + stack. |
| `flightbox_walk` | Walk up or down the call tree from any span. |
| `flightbox_search` | Find spans by function name, text in args/output/errors, duration, etc. |
| `flightbox_recent` | Polling-friendly incremental feed. Fetch spans since a cursor (`since_started_at` + `since_span_id`). |
| `flightbox_siblings` | Everything that ran under the same parent, in execution order. |
| `flightbox_failing` | Recent errors, grouped by error type. |
| `flightbox_entities` | Entity-level summary from tracked mutations (create/update/delete/upsert/custom). |
| `flightbox_entity_timeline` | Time-ordered entity mutation stream with span IDs so you can walk the call graph. |
| `flightbox_query` | Raw DuckDB SQL against spans. Full power — aggregations, JSON extraction, window functions. |

### Entity mutation tracking

When domain entities are created/updated/deleted in your code, annotate those points directly:

```ts
import {
  trackEntityCreate,
  trackEntityUpdate,
  trackEntityDelete,
} from '@flightbox/sdk'

trackEntityCreate('PAWN', pawn.id, pawn, { zone: pawn.zone })
trackEntityUpdate('PAWN', pawn.id, { x: { from: 12, to: 14 } }, pawn, { frame: tick })
trackEntityDelete('PAWN', pawn.id, pawn)
```

These entity events are attached to the current span and become queryable via:

- `flightbox_entities` to answer "what entity types changed recently?"
- `flightbox_entity_timeline` to answer "show me PAWN changes over time and where in the call graph they happened"

### Raw SQL queries

`flightbox_query` lets the LLM write arbitrary DuckDB SQL against a `spans` table. This is how you do ad-hoc analysis that the structured tools don't cover:

```sql
-- Which functions are called most often?
SELECT name, COUNT(*) as calls, AVG(duration_ms) as avg_ms
FROM spans GROUP BY name ORDER BY calls DESC LIMIT 20

-- Extract entity IDs from serialized args
SELECT JSON_EXTRACT_STRING(input, '$[0].id') as entity_id,
       AVG(duration_ms) as avg_ms, MAX(duration_ms) as max_ms
FROM spans WHERE name = 'update'
GROUP BY entity_id ORDER BY avg_ms DESC

-- Find the slowest trace
SELECT trace_id, SUM(duration_ms) as total_ms, COUNT(*) as span_count
FROM spans GROUP BY trace_id ORDER BY total_ms DESC LIMIT 5

-- Track object state changes across frames
SELECT name,
       JSON_EXTRACT_STRING(context, '$.pathProgress') as progress,
       JSON_EXTRACT_STRING(context, '$.currentX') as x,
       duration_ms
FROM spans WHERE name = 'updateAgents'
ORDER BY started_at DESC LIMIT 20

-- Find when a path rebuilds (detect interpolation stutters)
WITH ordered AS (
  SELECT input, started_at,
    LAG(input) OVER (ORDER BY started_at) as prev_input
  FROM spans WHERE name = 'buildPixelPath'
)
SELECT input, prev_input, started_at
FROM ordered WHERE input != prev_input
ORDER BY started_at DESC LIMIT 10
```

## What gets captured

Each function call produces a span:

- **span_id / trace_id / parent_id** — the call tree structure
- **name, module, file_line** — where in your code
- **input** — JSON-serialized arguments (depth-limited, truncated)
- **output** — JSON-serialized return value
- **error** — JSON-serialized error with stack trace
- **context** — JSON-serialized `this` for class methods (depth 1, primitives prioritized). `null` for non-method calls.
- **tags** — optional structured metadata attached to a span (for example tracked entity mutations)
- **started_at / ended_at / duration_ms** — timing
- **git_sha** — which commit

### Serialization

Serialization is depth-limited (5 levels), breadth-limited (10 complex values per object/array), and string-truncated (512 chars). Circular references are detected. Primitive values (strings, numbers, booleans) are always included regardless of the breadth limit — only objects and arrays count against it. This ensures class state like `pathProgress`, `currentX` aren't crowded out by framework internals.

### Git-scoped instrumentation

The Vite plugin automatically detects recently changed files via `git diff --name-only HEAD~5 HEAD` and only instruments those files. This keeps traces focused on your active work and avoids instrumenting hot-path utility functions in unchanged code. You can extend the scope with explicit `include` patterns.

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
| `@flightbox/sdk` | Runtime SDK (Node + browser) | [![npm](https://img.shields.io/npm/v/@flightbox/sdk)](https://www.npmjs.com/package/@flightbox/sdk) |
| `@flightbox/mcp-server` | MCP query tools | [![npm](https://img.shields.io/npm/v/@flightbox/mcp-server)](https://www.npmjs.com/package/@flightbox/mcp-server) |
| `@flightbox/core` | Shared types & serializer | [![npm](https://img.shields.io/npm/v/@flightbox/core)](https://www.npmjs.com/package/@flightbox/core) |
| `@flightbox/babel-plugin` | Babel transform (legacy) | [![npm](https://img.shields.io/npm/v/@flightbox/babel-plugin)](https://www.npmjs.com/package/@flightbox/babel-plugin) |

## Performance benchmarking

Measure wrapper-construction overhead (legacy per-call style vs wrap-once style):

```bash
pnpm bench:wrap
```

Optional tuning knobs:

- `BENCH_RUNS` (default `5`)
- `BENCH_SYNC_ITERS` (default `300000`)
- `BENCH_METHOD_ITERS` (default `300000`)
- `BENCH_ASYNC_ITERS` (default `40000`)

The benchmark prints:

1. human-readable per-scenario summary (legacy ms, optimized ms, improvement %, speedup)
2. machine-readable JSON report for regression tracking

For stable comparisons:

- run on a mostly idle machine
- keep Node version fixed
- compare multiple consecutive runs, not a single sample

### Transform diagnostics

To inspect transformer overhead and wrapping volume while running your app/build:

```bash
FLIGHTBOX_DEBUG_TRANSFORM=1 <your-command>
```

At process exit, Flightbox logs:

- total transformed files
- how many files were instrumented
- total wrapped nodes
- top 10 slowest transformed files

## License

MIT
