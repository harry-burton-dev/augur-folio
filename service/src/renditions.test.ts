import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { lead, lucia, setUpApp, tomas } from './app.testing.ts';
import { DATABASE_URL, testDatabase } from './db.testing.ts';
import { FAILED_WHY, renditionWorker, type WorkerLog } from './renditions.ts';
import type { render } from './render.ts';

const db = testDatabase('folio_renditions_test');
const quiet: WorkerLog = { info: () => undefined, warn: () => undefined, error: () => undefined };
const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

/** The app, a folder Tomas can add to, and a worker on the same store and bucket. */
const setUp = async (renderer?: typeof render) => {
  const s = await setUpApp(db);
  const collection = (await s.as(lead).call('POST', '/folders', { name: 'Harbour' })).json();
  const worker = renditionWorker({ store: db.store, objects: s.objects, log: quiet, ...(renderer ? { renderer } : {}) });
  const add = async (filename: string, body: Buffer | string, type: string) => (await s.as(tomas).upload(`/folders/${collection.id}/documents?filename=${encodeURIComponent(filename)}`, body, type)).json();
  return { ...s, worker, add };
};

describe.skipIf(!DATABASE_URL)('reader copies', () => {
  it('queues a copy with each version and serves it once the worker has made it (T1)', async () => {
    const s = await setUp();
    const document = await s.add('timetable.docx', await fixture('timetable.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(document.latest).toMatchObject({ reader: 'queued', thumbnail: false });
    expect((await s.as(lucia).call('GET', `/documents/${document.id}/versions/1/reader`)).json()).toMatchObject({ state: 'queued', why: expect.any(String), retry: false });

    expect(await s.worker.once()).toBe(true);
    expect(await s.worker.once()).toBe(false);
    const reader = (await s.as(lucia).call('GET', `/documents/${document.id}/versions/1/reader`)).json();
    expect(reader).toMatchObject({ state: 'ready', retry: false });
    expect(reader.markdown).toContain('# Ferry timetable');
    // The picture the Markdown names is under the app's own API, where the host fetches it.
    const src = /\]\((v1\/[^)]+)\)/.exec(reader.markdown)![1]!;
    const picture = await s.as(lucia).call('GET', src.slice('v1'.length));
    expect(picture.statusCode).toBe(200);
    expect(picture.headers['content-type']).toBe('image/png');
    expect((await s.as(lucia).call('GET', `/documents/${document.id}/versions/1/pictures/9.png`)).statusCode).toBe(404);
    expect((await s.as(lucia).call('GET', `/documents/${document.id}/versions/1/pictures/..%2Fx.png`)).statusCode).toBe(400);
  });

  it('makes a PDF’s first page its thumbnail, and finds it by words inside it', async () => {
    const s = await setUp();
    const document = await s.add('plan.pdf', await fixture('plan.pdf'), 'application/pdf');
    expect((await s.as(lucia).call('GET', '/search?q=dredg')).json().results).toEqual([]);
    await s.worker.once();
    expect((await s.as(lucia).call('GET', `/documents/${document.id}`)).json().versions[0]).toMatchObject({ reader: 'ready', thumbnail: true });
    const thumbnail = await s.as(lucia).call('GET', `/documents/${document.id}/versions/1/thumbnail`);
    expect(thumbnail.headers['content-type']).toBe('image/png');
    expect((await s.as(lucia).call('GET', '/search?q=dredg')).json().results).toEqual([expect.objectContaining({ id: document.id })]);
  });

  it('says why a file has no copy to read', async () => {
    const s = await setUp();
    const document = await s.add('budget.xlsx', 'cells', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    await s.worker.once();
    expect((await s.as(lucia).call('GET', `/documents/${document.id}/versions/1/reader`)).json()).toEqual({ state: 'none', why: expect.stringContaining('.xlsx'), retry: false });
  });

  it('tries three times, then says it couldn’t, and an editor can ask again', async () => {
    let calls = 0;
    const s = await setUp(async () => {
      calls++;
      throw new Error('pdftotext: broken');
    });
    const document = await s.add('plan.pdf', '%PDF-1.7 broken', 'application/pdf');
    await s.worker.once();
    // A failed try waits before the next: bring it forward instead of waiting a minute.
    const due = () => db.pool.query(`update renditions set queued_at = now() - interval '1 second' where state = 'queued'`);
    await due();
    await s.worker.once();
    await due();
    await s.worker.once();
    expect(calls).toBe(3);
    expect(await s.worker.once()).toBe(false);
    expect((await s.as(lucia).call('GET', `/documents/${document.id}/versions/1/reader`)).json()).toEqual({ state: 'failed', why: FAILED_WHY, retry: false });
    expect((await s.as(tomas).call('GET', `/documents/${document.id}/versions/1/reader`)).json()).toMatchObject({ retry: true });
    expect((await s.as(lucia).call('POST', `/documents/${document.id}/versions/1/reader`)).statusCode).toBe(403);
    expect((await s.as(tomas).call('POST', `/documents/${document.id}/versions/1/reader`)).statusCode).toBe(202);
    expect((await s.as(tomas).call('POST', `/documents/${document.id}/versions/1/reader`)).statusCode).toBe(409);
    await s.worker.once();
    expect(calls).toBe(4);
  });

  it('takes over a copy whose worker stopped, and never lets the old one write over it', async () => {
    const s = await setUp();
    await s.add('notes.md', '# Notes', 'text/markdown');
    const first = (await db.store.takeRendition(60))!;
    // Its worker stopped holding it.
    await db.pool.query(`update renditions set lease_until = now() - interval '1 second'`);
    const second = (await db.store.takeRendition(60))!;
    expect(second).toMatchObject({ version: first.version, tries: 2 });
    expect(await db.store.takeRendition(60)).toBeUndefined();
    expect(await db.store.finishRendition(first, { state: 'none', why: 'late' })).toBe(false);
    expect(await db.store.finishRendition(second, { state: 'none', why: 'kept' })).toBe(true);
  });

  it('clears a deleted document’s copies with its files', async () => {
    const s = await setUp();
    const document = await s.add('plan.pdf', await fixture('plan.pdf'), 'application/pdf');
    await s.worker.once();
    expect([...s.objects.files.keys()].filter((k) => k.startsWith('renditions/'))).toHaveLength(2);
    await s.as(lead).call('DELETE', `/documents/${document.id}`);
    await db.pool.query(`update documents set deleted_at = now() - interval '40 days'`);
    const keys = (await db.store.purgeable(30))[0]!.keys;
    expect(keys.filter((k) => k.startsWith('renditions/'))).toHaveLength(2);
  });
});
