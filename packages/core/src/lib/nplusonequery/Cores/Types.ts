// ─────────────────────────────────────────────
//  Core Types for smart-nplusone-guard
// ─────────────────────────────────────────────

export interface QueryMeta {
  table: string;
  column: string;
  key: string | number;
  timestamp: number;
  /** caller-supplied resolver so the batcher can fulfil the original promise */
  resolve: (result: unknown) => void;
  reject: (err: unknown) => void;
}

export interface QuerySignature {
  /** e.g. "posts:user_id" */
  id: string;
  table: string;
  column: string;
}

export interface BatchEntry {
  keys: Array<string | number>;
  resolvers: Map<string | number, Array<(result: unknown) => void>>;
  rejecters: Map<string | number, Array<(err: unknown) => void>>;
  timer: ReturnType<typeof setTimeout> | null;
  createdAt: number;
}

// The function the consumer must supply: given a list of keys,
// return a Map of key → row(s).
export type BatchExecutorFn<TKey extends string | number, TResult> = (
  keys: TKey[]
) => Promise<Map<TKey, TResult>>;

export interface GuardOptions {
  /**
   * How long (ms) to wait before flushing a batch.
   * Default: 5
   */
  windowMs?: number;

  /**
   * Maximum keys in one batch before it is flushed early.
   * Default: 100
   */
  maxBatchSize?: number;

  /**
   * How many identical-signature queries must arrive within
   * `windowMs` before N+1 is flagged in logs.
   * Default: 3
   */
  detectionThreshold?: number;

  /**
   * Called whenever a new N+1 pattern is detected (first time only).
   */
  onDetected?: (sig: QuerySignature, count: number) => void;

  /**
   * Called after each batch execution.
   */
  onBatchExecuted?: (sig: QuerySignature, batchSize: number, durationMs: number) => void;

  /** Enable verbose console logging. Default: false */
  debug?: boolean;
}

export interface GuardMetrics {
  queriesSaved: number;
  batchesExecuted: number;
  detectedPatterns: Set<string>;
}