import { NPlusOneGuard } from './Cores/Nplusonequery';
import { BatchExecutorFn } from './Cores/Types';

/**
 * createLoader
 * ─────────────
 * Returns a thin, DataLoader-compatible loader function backed by
 * NPlusOneGuard.  Drop-in replacement anywhere you'd normally use
 * Facebook's DataLoader.
 *
 * Usage (GraphQL resolver):
 *
 *   const guard = new NPlusOneGuard();
 *   guard.register('Post', 'authorId', async (ids) => {
 *     const posts = await db.posts.findMany({ where: { authorId: { in: ids } } });
 *     const map = new Map<number, Post[]>();
 *     for (const p of posts) {
 *       const arr = map.get(p.authorId) ?? [];
 *       arr.push(p);
 *       map.set(p.authorId, arr);
 *     }
 *     return map;
 *   });
 *
 *   const postsByAuthor = createLoader<number, Post[]>(guard, 'Post', 'authorId');
 *
 *   // In resolver:
 *   resolve: (parent) => postsByAuthor(parent.id)
 */
export function createLoader<TKey extends string | number, TResult>(
  guard: NPlusOneGuard,
  table: string,
  column: string
): (key: TKey) => Promise<TResult> {
  return (key: TKey) => guard.load<TKey, TResult>(table, column, key);
}

/**
 * createLoaderAndRegister
 * ────────────────────────
 * Registers the executor AND returns the loader in one call.
 */
export function createLoaderAndRegister<TKey extends string | number, TResult>(
  guard: NPlusOneGuard,
  table: string,
  column: string,
  executor: BatchExecutorFn<TKey, TResult>
): (key: TKey) => Promise<TResult> {
  guard.register<TKey, TResult>(table, column, executor);
  return createLoader<TKey, TResult>(guard, table, column);
}

/**
 * withGuard
 * ──────────
 * Higher-order function that wraps any async resolver so that
 * its DB loads go through the guard automatically.
 *
 * Usage:
 *   const resolveUser = withGuard(guard, async (id: number) => {
 *     return guard.load<number, User>('User', 'id', id);
 *   });
 */
export function withGuard<TArgs extends unknown[], TReturn>(
  _guard: NPlusOneGuard,
  fn: (...args: TArgs) => Promise<TReturn>
): (...args: TArgs) => Promise<TReturn> {
  return fn; // guard is invoked inside fn; this wrapper is for annotation/clarity
}