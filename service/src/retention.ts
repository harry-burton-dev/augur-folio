import type { JobLogger } from '@augur/service-kit';
import type { ObjectStore } from './objects.ts';
import type { Store } from './store.ts';

/**
 * Clears what a deleted document kept once the retention setting's days have passed: every version's file
 * leaves the bucket, and the document is marked purged so it can't be restored. Its record stays, so the
 * audit log and anything that named it can still say what it was.
 */
export const purgeDeleted = async ({ store, objects, days, log }: { store: Store; objects: ObjectStore; days: number; log: Pick<JobLogger, 'info'> }) => {
  let cleared = 0;
  for (;;) {
    const batch = await store.purgeable(days);
    if (!batch.length) break;
    for (const d of batch) {
      for (const key of d.keys) await objects.delete(key);
      await store.purged(d.id);
      cleared += 1;
    }
  }
  if (cleared) log.info({ cleared, days }, 'cleared deleted documents past the retention period');
  return cleared;
};
