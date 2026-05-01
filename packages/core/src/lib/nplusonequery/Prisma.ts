import { NPlusOneGuard } from './Cores/Nplusonequery';
import { BatchExecutorFn } from './Cores/Types';

/**
 * createPrismaMiddleware
 * ──────────────────────
 * Wraps Prisma's $use middleware API to intercept `findUnique` and
 * `findFirst` calls that match registered (model, field) loaders,
 * transparently batching them through NPlusOneGuard.
 *
 * Usage:
 *
 *   const guard = new NPlusOneGuard({ debug: true });
 *
 *   // Register loader: given a list of user IDs, return Map<id, User>
 *   guard.register('User', 'id', async (ids) => {
 *     const users = await prisma.user.findMany({ where: { id: { in: ids } } });
 *     return new Map(users.map(u => [u.id, u]));
 *   });
 *
 *   const middleware = createPrismaMiddleware(guard);
 *   prisma.$use(middleware);
 *
 * For any prisma.user.findUnique({ where: { id: X } }) call, the
 * middleware will batch all concurrent calls and fire a single
 * prisma.user.findMany(...) instead.
 */
export function createPrismaMiddleware(guard: NPlusOneGuard) {
  return async (params: PrismaMiddlewareParams, next: PrismaNextFn) => {
    // Only intercept single-record reads
    if (
      params.action !== 'findUnique' &&
      params.action !== 'findFirst'
    ) {
      return next(params);
    }

    const where = (params.args?.where ?? {}) as Record<string, unknown>;
    const keys = Object.keys(where);

    // Only intercept simple equality lookups: { id: 42 }
    const firstVal = where[keys[0]];
    if (keys.length !== 1 || (typeof firstVal !== 'string' && typeof firstVal !== 'number')) {
      return next(params);
    }

    const column  = keys[0];
    const keyVal  = firstVal as string | number;
    const table   = params.model!;

    // Check if a loader is registered; if not, fall through to Prisma
    try {
      return await guard.load(table, column, keyVal);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('no executor registered')) {
        return next(params);
      }
      throw err;
    }
  };
}

// ─── Minimal Prisma middleware type stubs ───────────────────────────────────
// (avoids requiring @prisma/client as a hard dependency)

export interface PrismaMiddlewareParams {
  model?: string;
  action: string;
  args: Record<string, unknown>;
  dataPath: string[];
  runInTransaction: boolean;
}

export type PrismaNextFn = (params: PrismaMiddlewareParams) => Promise<unknown>;


/**
 * registerPrismaLoader
 * ─────────────────────
 * Helper that wires up a type-safe loader for a Prisma model field.
 *
 * @param guard    - NPlusOneGuard instance
 * @param model    - Prisma model name (e.g. "User", "Post")
 * @param field    - The lookup field (e.g. "id", "userId")
 * @param executor - Your batch fetch function
 */
export function registerPrismaLoader<TKey extends string | number, TResult>(
  guard: NPlusOneGuard,
  model: string,
  field: string,
  executor: BatchExecutorFn<TKey, TResult>
): void {
  guard.register<TKey, TResult>(model, field, executor);
}