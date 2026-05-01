import { QuerySignature, GuardOptions } from './Types';

/**
 * DetectionEngine
 * ─────────────────
 * Tracks query-signature frequency inside a rolling time window.
 * When a signature exceeds `detectionThreshold` hits within `windowMs`,
 * it is flagged as an N+1 pattern.
 */
export class DetectionEngine {
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly onDetected?: (sig: QuerySignature, count: number) => void;
  private readonly debug: boolean;

  // signature id → sorted list of hit timestamps
  private readonly hits: Map<string, number[]> = new Map();
  // signatures already reported so we don't spam logs
  private readonly reported: Set<string> = new Set();

  constructor(opts: Required<Pick<GuardOptions, 'windowMs' | 'detectionThreshold' | 'debug'>> & {
    onDetected?: GuardOptions['onDetected'];
  }) {
    this.windowMs   = opts.windowMs;
    this.threshold  = opts.detectionThreshold;
    this.onDetected = opts.onDetected;
    this.debug      = opts.debug;
  }

  /**
   * Record a query hit for the given signature.
   * Returns true if this hit pushed us over the N+1 threshold.
   */
  record(sig: QuerySignature): boolean {
    const now = Date.now();
    let timestamps = this.hits.get(sig.id) ?? [];

    // Drop timestamps outside the rolling window
    timestamps = timestamps.filter(t => now - t <= this.windowMs);
    timestamps.push(now);
    this.hits.set(sig.id, timestamps);

    const count = timestamps.length;
    const exceeded = count >= this.threshold;

    if (exceeded && !this.reported.has(sig.id)) {
      this.reported.add(sig.id);
      if (this.debug) {
        console.warn(
          `[NPlusOneGuard] ⚠  N+1 detected — signature="${sig.id}" ` +
          `hit ${count}x within ${this.windowMs}ms`
        );
      }
      this.onDetected?.(sig, count);
    }

    return exceeded;
  }

  /** Expose current frequency for a signature (useful for tests). */
  getCount(sigId: string): number {
    const now = Date.now();
    const timestamps = (this.hits.get(sigId) ?? []).filter(
      t => now - t <= this.windowMs
    );
    return timestamps.length;
  }

  /** Clear all tracked state (useful between tests). */
  reset(): void {
    this.hits.clear();
    this.reported.clear();
  }
}