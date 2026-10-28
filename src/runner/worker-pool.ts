/**
 * Runs `worker` over `items` with at most `concurrency` in flight. Once `shouldStop()` is true no
 * new item is started; items already in flight are always awaited (they can't be cancelled safely
 * mid-migration). Unstarted items come back as `undefined`.
 *
 * `worker` must handle its own errors; a rejection here would be a bug and is propagated after
 * the in-flight work settles.
 */
export async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  shouldStop: () => boolean,
): Promise<Array<R | undefined>> {
  const results: Array<R | undefined> = new Array(items.length).fill(undefined);
  let next = 0;
  let fatal: { error: unknown } | undefined;

  const lane = async () => {
    while (!fatal && !shouldStop()) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index] as T, index);
      } catch (error) {
        fatal ??= { error };
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  if (fatal) throw fatal.error;
  return results;
}
