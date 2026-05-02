import {
  BatchEntry,
  BatchExecutorFn,
  GuardMetrics,
  GuardOptions,
  QuerySignature,
} from './Types';

/**
 * BatchQueue
 * ───────────
 * One instance per query signature.
 * Collects individual key lookups, then fires a single batched query
 * either when:
 *   (a) `maxBatchSize` keys have accumulated, OR
 *   (b) `windowMs` milliseconds have elapsed since the first key arrived.
 *
 * The caller supplies a `BatchExecutorFn` that knows how to turn
 *   [1, 2, 3]  →  Map{ 1 → row, 2 → row, 3 → row }
 */
export class BatchQueue<TKey extends string | number, TResult> {
  private readonly sig: QuerySignature;
  private readonly executor: BatchExecutorFn<TKey, TResult>;
  private readonly windowMs: number;
  private readonly maxBatchSize: number;
  private readonly onBatchExecuted?: GuardOptions['onBatchExecuted'];
  private readonly debug: boolean;
  private readonly metrics: GuardMetrics;

  private current: BatchEntry | null = null;

  constructor(
    sig: QuerySignature,
    executor: BatchExecutorFn<TKey, TResult>,
    opts: Required<Pick<GuardOptions, 'windowMs' | 'maxBatchSize' | 'debug'>> & {
      onBatchExecuted?: GuardOptions['onBatchExecuted'];
    },
    metrics: GuardMetrics
  ) {
    this.sig             = sig;
    this.executor        = executor;
    this.windowMs        = opts.windowMs;
    this.maxBatchSize    = opts.maxBatchSize;
    this.onBatchExecuted = opts.onBatchExecuted;
    this.debug           = opts.debug;
    this.metrics         = metrics;
  }

  /**
   * Enqueue a single key lookup.
   * Returns a promise that resolves with the result for this specific key.
   */
  enqueue(key: TKey): Promise<TResult> {
    return new Promise<TResult>((resolve, reject) => {
      if (!this.current) {
        this.current = {
          keys: [],
          resolvers: new Map(),
          rejecters: new Map(),
          timer: null,
          createdAt: Date.now(),
        };

        // Schedule auto-flush after windowMs
        this.current.timer = setTimeout(() => this.flush(), this.windowMs);
      }

      const entry = this.current;

      // Collect key (allow duplicates; result mapper handles fan-out)
      entry.keys.push(key);

      if (!entry.resolvers.has(key)) {
        entry.resolvers.set(key, []);
        entry.rejecters.set(key, []);
      }
      entry.resolvers.get(key)!.push(resolve as (v: unknown) => void);
      entry.rejecters.get(key)!.push(reject);

      if (this.debug) {
        console.debug(
          `[NPlusOneGuard] enqueue key=${key} sig="${this.sig.id}" ` +
          `(batch size=${entry.keys.length})`
        );
      }

      // Flush early if we've hit the max batch size
      if (entry.keys.length >= this.maxBatchSize) {
        this.flush();
      }
    });
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private flush(): void {
    const entry = this.current;
    if (!entry) return;

    // Detach immediately so new enqueues start a fresh batch
    this.current = null;
    if (entry.timer) clearTimeout(entry.timer);

    const uniqueKeys = [...new Set(entry.keys)] as TKey[];
    const start = Date.now();

    if (this.debug) {
      console.debug(
        `[NPlusOneGuard] flushing batch sig="${this.sig.id}" keys=[${uniqueKeys.join(',')}]`
      );
    }

    this.executor(uniqueKeys)
      .then(resultMap => {
        const durationMs = Date.now() - start;

        // Update metrics
        this.metrics.batchesExecuted += 1;
        // queries saved = total individual calls that were merged - 1 actual call
        this.metrics.queriesSaved += entry.keys.length - 1;

        this.onBatchExecuted?.(this.sig, uniqueKeys.length, durationMs);

        if (this.debug) {
          console.debug(
            `[NPlusOneGuard] batch done sig="${this.sig.id}" ` +
            `keys=${uniqueKeys.length} duration=${durationMs}ms`
          );
        }

        // Fan results back to each waiting promise
        for (const key of entry.keys) {
          const result = resultMap.get(key as TKey);
          const resolvers = entry.resolvers.get(key) ?? [];
          for (const resolve of resolvers) resolve(result);
        }
      })
      .catch(err => {
        // Reject every waiting promise
        for (const rejecterList of entry.rejecters.values()) {
          for (const reject of rejecterList) reject(err);
        }
      });
  }
}