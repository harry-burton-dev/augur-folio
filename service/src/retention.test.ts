import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { FolioAuditEntry } from './audit.ts';
import { MemoryObjectStore } from './objects.ts';
import { clearDeleted } from './retention.ts';
import { MemoryFolioStore, objectKeyFor } from './store.ts';

const DAY = 24 * 60 * 60 * 1000;
const log = { error: () => {} };

const withDocuments = async () => {
  const store = new MemoryFolioStore();
  const objects = new MemoryObjectStore();
  const lib = await store.createLibrary({ workspace: 'w-fin', floor: 'tree:w-fin', name: 'Policies', createdBy: 'u-1' });
  for (const id of ['d-gone', 'd-kept']) {
    const key = objectKeyFor(id, `v-${id}`);
    await store.createDocument({ id, library: lib.id, title: id, createdBy: 'u-1' }, { id: `v-${id}`, filename: 'a.md', mediaType: 'text/markdown', size: 1, sha256: 'ab'.repeat(32), objectKey: key, createdBy: 'u-1' });
    await objects.put(key, Readable.from(['x']), 'text/markdown');
  }
  await store.finishRendition('v-d-gone', { state: 'ready', engine: 'docling', engineVersion: '2', readerKey: 'renditions/v-d-gone/reader.md', images: ['1.png'], text: 'x' });
  await objects.put('renditions/v-d-gone/reader.md', Readable.from(['x']), 'text/markdown');
  await objects.put('renditions/v-d-gone/images/1.png', Readable.from(['x']), 'image/png');
  await store.deleteDocument('d-gone', 'u-1');
  return { store, objects, lib };
};

describe('clearing deleted documents', () => {
  it('keeps them for the retention period, then removes every file of theirs and says so in the audit log', async () => {
    const { store, objects, lib } = await withDocuments();
    const entries: FolioAuditEntry[] = [];
    const audit = async (e: FolioAuditEntry) => void entries.push(e);
    expect(await clearDeleted({ store, objects, days: 30, audit, log, now: new Date(Date.now() + 29 * DAY) })).toBe(0);
    expect(objects.files.size).toBe(4);
    expect(await clearDeleted({ store, objects, days: 30, audit, log, now: new Date(Date.now() + 31 * DAY) })).toBe(1);
    expect([...objects.files.keys()]).toEqual([objectKeyFor('d-kept', 'v-d-kept')]);
    expect(entries).toEqual([
      { actor: 'folio', actorKind: 'service', action: 'document.purged', target: 'd-gone', workspace: 'w-fin', detail: expect.objectContaining({ library: lib.id, title: 'd-gone', retentionDays: 30 }) },
    ]);
    expect(await clearDeleted({ store, objects, days: 30, audit, log, now: new Date(Date.now() + 31 * DAY) })).toBe(0);
  });

  it('leaves a document to try again when one of its files can’t be removed', async () => {
    const { store, objects } = await withDocuments();
    const failing = Object.assign(Object.create(objects), { delete: async () => Promise.reject(new Error('bucket unreachable')) });
    await expect(clearDeleted({ store, objects: failing, days: 1, audit: async () => {}, log, now: new Date(Date.now() + 2 * DAY) })).rejects.toThrow('bucket unreachable');
    expect(await store.purgeable(new Date(Date.now() + 2 * DAY).toISOString(), 10)).toHaveLength(1);
  });
});
