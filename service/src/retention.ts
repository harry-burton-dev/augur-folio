import type { Audit } from './audit.ts';
import type { ObjectStore } from './objects.ts';
import type { FolioStore } from './store.ts';

/** Folio's setting (its manifest's `settings`) for how long a deleted document is kept, in days. */
export const RETENTION_SETTING = 'retentionDays';
/** How long a deleted document is kept when nobody has said otherwise. Matches the manifest's default. */
export const DEFAULT_RETENTION_DAYS = 30;
/** How many deleted documents are cleared at a time. */
const BATCH = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ClearOptions {
  store: FolioStore;
  objects: ObjectStore;
  /** How many days a deleted document is kept, as an admin set it in Admin, Apps. */
  days: number;
  audit: Audit;
  log: { error(obj: object, msg: string): void };
  now?: Date;
}

/**
 * Clears away deleted documents once they're older than the retention period: every file
 * of theirs leaves the bucket and their text is forgotten. Their record stays, so the audit
 * log can still name them. Files go first, so a document is only marked cleared once nothing
 * of it is left; if a file can't be removed, that document is tried again next time.
 * Returns how many were cleared.
 */
export const clearDeleted = async ({ store, objects, days, audit, log, now = new Date() }: ClearOptions) => {
  const before = new Date(now.getTime() - days * DAY_MS).toISOString();
  let cleared = 0;
  for (;;) {
    const due = await store.purgeable(before, BATCH);
    for (const doc of due) {
      for (const key of doc.keys) await objects.delete(key);
      if (!(await store.markPurged(doc.id))) continue;
      cleared++;
      await audit({
        actor: 'folio',
        actorKind: 'service',
        action: 'document.purged',
        target: doc.id,
        workspace: doc.workspace,
        detail: { library: doc.library, title: doc.title, deletedAt: doc.deletedAt, retentionDays: days },
      }).catch((err: Error) => log.error({ err: err.message, document: doc.id }, 'could not record a cleared document'));
    }
    if (due.length < BATCH) return cleared;
  }
};
