import { createSpan, completeSpan, failSpan } from "@flightbox/core";
import type { SpanMeta } from "@flightbox/core";
import { storage } from "./context.js";
import { getConfig } from "./config.js";
import { bufferSpan } from "./buffer.js";

export function __flightbox_wrap<T extends (...args: any[]) => any>(
  fn: T,
  meta: SpanMeta,
): T {
  // Detect generator functions — they return iterators, not promises
  const isGenerator = fn.constructor?.name === "GeneratorFunction" ||
    fn.constructor?.name === "AsyncGeneratorFunction";

  const wrapped = function (this: unknown, ...args: unknown[]) {
    const cfg = getConfig();
    if (!cfg.enabled) return fn.apply(this, args);

    const parent = storage.getStore();
    const span = createSpan(meta, parent, args, this);
    span.git_sha = cfg.gitSha;

    return storage.run(
      { trace_id: span.trace_id, span_id: span.span_id },
      () => {
        try {
          const result = fn.apply(this, args);

          // Generators return iterators — record the span immediately and pass through
          if (isGenerator) {
            completeSpan(span, "[Generator]");
            bufferSpan(span);
            return result;
          }

          if (result && typeof result === "object" && typeof (result as any).then === "function") {
            return (result as Promise<unknown>).then(
              (val) => {
                completeSpan(span, val);
                bufferSpan(span);
                return val;
              },
              (err) => {
                failSpan(span, err);
                bufferSpan(span);
                throw err;
              },
            );
          }

          completeSpan(span, result);
          bufferSpan(span);
          return result;
        } catch (err) {
          failSpan(span, err);
          bufferSpan(span);
          throw err;
        }
      },
    );
  } as unknown as T;

  // Preserve function name for debugging
  Object.defineProperty(wrapped, "name", { value: fn.name });
  Object.defineProperty(wrapped, "length", { value: fn.length });

  return wrapped;
}
