import {
  BatchExecutorFn,
  GuardMetrics,
  GuardOptions,
  QuerySignature,
} from './Types';
import { DetectionEngine } from './Detectionengine';
import { BatchQueue } from './Batchqueue';

const DEFAULTS: Required<GuardOptions> = {
  windowMs:           5,
  maxBatchSize:       100,
  detectionThreshold: 3,
  onDetected:         undefined as unknown as Required<GuardOptions>['onDetected'],
  onBatchExecuted:    undefined as unknown as Required<GuardOptions>['onBatchExecuted'],
  debug:              false,
};

/**
 * NPlusOneGuard
 * ──────────────
 * Central orchestrator.
 *
 * Usage:
 *
 *   const guard = new NPlusOneGuard({ debug: true });
 *
 *   // Register one loader per (table, column) pair
 *   guard.register('posts', 'user_id', async (userIds) => {
 *     const rows = await db.query(
 *       `SELECT * FROM posts WHERE user_id IN (${userIds.join(',')})`
 *     );
 *     const map = new Map<number, Post[]>();
 *     for (const row of rows) {
 *       if (!map.has(row.user_id)) map.set(row.user_id, []);
 *       map.get(row.user_id)!.push(row);
 *     }
 *     return map;
 *   });
 *
 *   // Anywhere in your resolver / service layer:
 *   const posts = await guard.load<number, Post[]>('posts', 'user_id', userId);
 */
export class NPlusOneGuard {
  private readonly opts: Required<GuardOptions>;
  private readonly detection: DetectionEngine;
  private readonly queues: Map<string, BatchQueue<any, any>> = new Map();
  private readonly executors: Map<string, BatchExecutorFn<any, any>> = new Map();

  readonly metrics: GuardMetrics = {
    queriesSaved:      0,
    batchesExecuted:   0,
    detectedPatterns:  new Set(),
  };

  constructor(opts: GuardOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };

    this.detection = new DetectionEngine({
      windowMs:           this.opts.windowMs,
      detectionThreshold: this.opts.detectionThreshold,
      debug:              this.opts.debug,
      onDetected: (sig, count) => {
        this.metrics.detectedPatterns.add(sig.id);
        this.opts.onDetected?.(sig, count);
      },
    });
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Register a batch executor for a (table, column) pair.
   * Must be called before the first `load()` for that signature.
   */
  register<TKey extends string | number, TResult>(
    table: string,
    column: string,
    executor: BatchExecutorFn<TKey, TResult>
  ): void {
    const sigId = buildSigId(table, column);
    if (this.executors.has(sigId)) {
      throw new Error(
        `[NPlusOneGuard] executor already registered for "${sigId}". ` +
        `Call unregister() first if you need to replace it.`
      );
    }
    this.executors.set(sigId, executor);
  }

  /** Remove a previously registered executor (and its pending queue). */
  unregister(table: string, column: string): void {
    const sigId = buildSigId(table, column);
    this.executors.delete(sigId);
    this.queues.delete(sigId);
  }

  /**
   * Load a single key.
   * Transparently batches with other concurrent loads for the same signature.
   *
   * Throws if no executor has been registered for this (table, column) pair.
   */
  async load<TKey extends string | number, TResult>(
    table: string,
    column: string,
    key: TKey
  ): Promise<TResult> {
    const sig: QuerySignature = {
      id: buildSigId(table, column),
      table,
      column,
    };

    // N+1 detection (fire-and-forget side effect)
    this.detection.record(sig);

    // Resolve or create the BatchQueue for this signature
    let queue = this.queues.get(sig.id) as BatchQueue<TKey, TResult> | undefined;

    if (!queue) {
      const executor = this.executors.get(sig.id) as
        | BatchExecutorFn<TKey, TResult>
        | undefined;

      if (!executor) {
        throw new Error(
          `[NPlusOneGuard] no executor registered for "${sig.id}". ` +
          `Call guard.register("${table}", "${column}", fn) first.`
        );
      }

      queue = new BatchQueue<TKey, TResult>(
        sig,
        executor,
        {
          windowMs:        this.opts.windowMs,
          maxBatchSize:    this.opts.maxBatchSize,
          debug:           this.opts.debug,
          onBatchExecuted: this.opts.onBatchExecuted,
        },
        this.metrics
      );

      this.queues.set(sig.id, queue);
    }

    return queue.enqueue(key);
  }

  /**
   * Convenience: load multiple keys at once, returns results in the same order.
   */
  async loadMany<TKey extends string | number, TResult>(
    table: string,
    column: string,
    keys: TKey[]
  ): Promise<TResult[]> {
    return Promise.all(keys.map(k => this.load<TKey, TResult>(table, column, k)));
  }

  /** Snapshot of current metrics. */
  getMetrics(): Readonly<GuardMetrics> {
    return { ...this.metrics, detectedPatterns: new Set(this.metrics.detectedPatterns) };
  }

  /** Reset detection state (useful in tests between scenarios). */
  resetDetection(): void {
    this.detection.reset();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildSigId(table: string, column: string): string {
  return `${table}:${column}`;
}