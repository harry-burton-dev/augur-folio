import { memoryJobs } from '@augur/service-kit';
import { describe, expect, it } from 'vitest';
import { renditionQueue, runIdFor } from './rendition-queue.ts';
import type { FolioStore } from './store.ts';

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

describe('the renditions queue', () => {
  it('hands each queued rendition to the worker once, by version and when it was queued', async () => {
    const jobs = memoryJobs({ app: 'folio', log: quiet });
    const queued = [
      { version: 'v1', queuedAt: '2026-11-03T10:00:00.000Z' },
      { version: 'v2', queuedAt: '2026-11-03T10:01:00.000Z' },
    ];
    const store = { queuedRenditions: async () => queued } as unknown as FolioStore;
    const { sweep } = renditionQueue(store, jobs, quiet);
    expect(await sweep()).toBe(2);
    await sweep();
    expect(await jobs.status(runIdFor('v1', queued[0].queuedAt))).toMatchObject({ job: 'renditions', state: 'queued' });
    expect(runIdFor('v1', queued[0].queuedAt)).toBe(`renditions-v1-${Date.parse(queued[0].queuedAt)}`);
  });

  it('logs, and hands nothing over, when the store can’t say what is queued', async () => {
    const errors: unknown[] = [];
    const jobs = memoryJobs({ app: 'folio', log: quiet });
    const store = { queuedRenditions: async () => Promise.reject(new Error('database restarting')) } as unknown as FolioStore;
    const { sweep } = renditionQueue(store, jobs, { ...quiet, error: (o) => errors.push(o) });
    expect(await sweep()).toBe(0);
    expect(errors).toHaveLength(1);
  });
});
