import { performance } from "node:perf_hooks";

type AnyFn = (...args: any[]) => any;

interface ScenarioResult {
  scenario: string;
  iterations: number;
  legacy_ms: number;
  optimized_ms: number;
  delta_ms: number;
  improvement_pct: number;
  speedup: number;
}

const SYNC_ITERS = Number(process.env.BENCH_SYNC_ITERS ?? 300_000);
const METHOD_ITERS = Number(process.env.BENCH_METHOD_ITERS ?? 300_000);
const ASYNC_ITERS = Number(process.env.BENCH_ASYNC_ITERS ?? 40_000);
const RUNS = Number(process.env.BENCH_RUNS ?? 5);

function mockWrap<T extends AnyFn>(fn: T): T {
  return function wrapped(this: unknown, ...args: unknown[]) {
    return fn.apply(this, args);
  } as T;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function measureSync(fn: () => void, runs: number): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return mean(samples);
}

async function measureAsync(fn: () => Promise<void>, runs: number): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }
  return mean(samples);
}

function benchmarkSyncFunction(iterations: number): ScenarioResult {
  function legacyAdd(a: number, b: number): number {
    return mockWrap(function () {
      return a + b;
    }).apply(this, arguments as unknown as any[]);
  }

  function optimizedAdd(a: number, b: number): number {
    const cached = (optimizedAdd as any).__flightbox_wrapped ??
      ((optimizedAdd as any).__flightbox_wrapped = mockWrap(function () {
        return a + b;
      }));
    return cached.apply(this, arguments as unknown as any[]);
  }

  // Warmup
  for (let i = 0; i < 20_000; i++) {
    legacyAdd(i, i + 1);
    optimizedAdd(i, i + 1);
  }

  let checksum = 0;
  const legacyMs = measureSync(() => {
    for (let i = 0; i < iterations; i++) checksum += legacyAdd(i, i + 1);
  }, RUNS);
  const optimizedMs = measureSync(() => {
    for (let i = 0; i < iterations; i++) checksum += optimizedAdd(i, i + 1);
  }, RUNS);

  if (checksum === 0) console.log("");

  const delta = legacyMs - optimizedMs;
  return {
    scenario: "sync_function_declaration",
    iterations,
    legacy_ms: legacyMs,
    optimized_ms: optimizedMs,
    delta_ms: delta,
    improvement_pct: legacyMs > 0 ? (delta / legacyMs) * 100 : 0,
    speedup: optimizedMs > 0 ? legacyMs / optimizedMs : 0,
  };
}

function benchmarkClassMethod(iterations: number): ScenarioResult {
  class LegacyCounter {
    inc(n: number): number {
      return mockWrap(function () {
        return n + 1;
      }).apply(this, arguments as unknown as any[]);
    }
  }

  class OptimizedCounter {
    inc(n: number): number {
      return n + 1;
    }

    static {
      const d = Object.getOwnPropertyDescriptor(this.prototype, "inc");
      if (d && typeof d.value === "function") {
        Object.defineProperty(this.prototype, "inc", {
          ...d,
          value: mockWrap(d.value),
        });
      }
    }
  }

  const legacy = new LegacyCounter();
  const optimized = new OptimizedCounter();

  // Warmup
  for (let i = 0; i < 20_000; i++) {
    legacy.inc(i);
    optimized.inc(i);
  }

  let checksum = 0;
  const legacyMs = measureSync(() => {
    for (let i = 0; i < iterations; i++) checksum += legacy.inc(i);
  }, RUNS);
  const optimizedMs = measureSync(() => {
    for (let i = 0; i < iterations; i++) checksum += optimized.inc(i);
  }, RUNS);

  if (checksum === 0) console.log("");

  const delta = legacyMs - optimizedMs;
  return {
    scenario: "class_instance_method",
    iterations,
    legacy_ms: legacyMs,
    optimized_ms: optimizedMs,
    delta_ms: delta,
    improvement_pct: legacyMs > 0 ? (delta / legacyMs) * 100 : 0,
    speedup: optimizedMs > 0 ? legacyMs / optimizedMs : 0,
  };
}

async function benchmarkAsyncFunction(iterations: number): Promise<ScenarioResult> {
  async function legacyFetch(n: number): Promise<number> {
    return mockWrap(async function () {
      return n + 1;
    }).apply(this, arguments as unknown as any[]);
  }

  async function optimizedFetch(n: number): Promise<number> {
    const cached = (optimizedFetch as any).__flightbox_wrapped ??
      ((optimizedFetch as any).__flightbox_wrapped = mockWrap(async function () {
        return n + 1;
      }));
    return cached.apply(this, arguments as unknown as any[]);
  }

  // Warmup
  for (let i = 0; i < 5_000; i++) {
    // eslint-disable-next-line no-await-in-loop
    await legacyFetch(i);
    // eslint-disable-next-line no-await-in-loop
    await optimizedFetch(i);
  }

  let checksum = 0;
  const legacyMs = await measureAsync(async () => {
    for (let i = 0; i < iterations; i++) {
      // eslint-disable-next-line no-await-in-loop
      checksum += await legacyFetch(i);
    }
  }, RUNS);
  const optimizedMs = await measureAsync(async () => {
    for (let i = 0; i < iterations; i++) {
      // eslint-disable-next-line no-await-in-loop
      checksum += await optimizedFetch(i);
    }
  }, RUNS);

  if (checksum === 0) console.log("");

  const delta = legacyMs - optimizedMs;
  return {
    scenario: "async_function_declaration",
    iterations,
    legacy_ms: legacyMs,
    optimized_ms: optimizedMs,
    delta_ms: delta,
    improvement_pct: legacyMs > 0 ? (delta / legacyMs) * 100 : 0,
    speedup: optimizedMs > 0 ? legacyMs / optimizedMs : 0,
  };
}

function formatMs(ms: number): string {
  return `${ms.toFixed(2)}ms`;
}

function formatPct(value: number): string {
  return `${value.toFixed(2)}%`;
}

async function main() {
  const results: ScenarioResult[] = [];
  results.push(benchmarkSyncFunction(SYNC_ITERS));
  results.push(benchmarkClassMethod(METHOD_ITERS));
  results.push(await benchmarkAsyncFunction(ASYNC_ITERS));

  console.log("\nFlightbox Wrap Overhead Benchmark");
  console.log("================================");
  for (const r of results) {
    console.log(
      `${r.scenario}: legacy=${formatMs(r.legacy_ms)} optimized=${formatMs(r.optimized_ms)} ` +
      `improvement=${formatPct(r.improvement_pct)} speedup=${r.speedup.toFixed(2)}x`,
    );
  }

  const report = {
    generated_at: new Date().toISOString(),
    runs: RUNS,
    results,
  };

  console.log("\nJSON Report");
  console.log("-----------");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
