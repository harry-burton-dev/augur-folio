import { Readable } from 'node:stream';
import { callerHeaders, type Caller } from '@augur/service-kit';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { MemoryObjectStore } from './objects.ts';
import { devRenderer } from './renditions.ts';
import { MemoryFolioStore, renditionPrefix } from './store.ts';

const sam: Caller = { id: 'u-sam', name: 'Sam Okafor', departments: [], roles: [] };
const alex: Caller = { id: 'u-alex', name: 'Alex Rivera', departments: [], roles: [] };
const kim: Caller = { id: 'u-kim', name: 'Kim Lee', departments: [], roles: [] };
const lead = (who: Caller, floor = 'w-fin'): Caller => ({ ...who, workspace: { id: floor, kind: 'team', role: 'lead' } });
const member = (who: Caller, floor = 'w-fin'): Caller => ({ ...who, workspace: { id: floor, kind: 'team', role: 'member' } });

const setup = async () => {
  const store = new MemoryFolioStore();
  const objects = new MemoryObjectStore();
  const app = await buildApp({ store, objects, audit: async () => {} });
  const get = (caller: Caller, url: string) => app.inject({ method: 'GET', url, headers: callerHeaders(caller) });
  const post = (caller: Caller, url: string) => app.inject({ method: 'POST', url, headers: callerHeaders(caller) });
  const { id: library } = (await app.inject({ method: 'POST', url: '/v1/libraries', headers: callerHeaders(lead(sam)), payload: { name: 'Policies' } })).json();
  const upload = async (caller: Caller, filename: string, body: string, type: string) => {
    const res = await app.inject({ method: 'POST', url: `/v1/libraries/${library}/documents?filename=${filename}`, headers: { ...callerHeaders(caller), 'content-type': type }, payload: body });
    const doc = res.json();
    return { doc, base: `/v1/libraries/${library}/documents/${doc.id}/versions/1` };
  };
  /** Does what the worker would: puts the files in the bucket and records them. */
  const render = async (version: string) => {
    const prefix = renditionPrefix(version);
    await objects.put(`${prefix}reader.md`, Readable.from(['# Travel\n\n![](images/1.png)\n']), 'text/markdown');
    await objects.put(`${prefix}images/1.png`, Readable.from([Buffer.from('png')]), 'image/png');
    await objects.put(`${prefix}thumbnail.png`, Readable.from([Buffer.from('thumb')]), 'image/png');
    await store.finishRendition(version, { state: 'ready', engine: 'docling', engineVersion: '2.14.0', readerKey: `${prefix}reader.md`, thumbnailKey: `${prefix}thumbnail.png`, images: ['1.png'], pages: 2, text: 'Travel' });
  };
  return { app, store, objects, get, post, upload, render };
};

describe('folio renditions', () => {
  it('says a reader copy is on its way until the worker has made it', async () => {
    const { get, upload } = await setup();
    const { doc, base } = await upload(member(alex), 'Travel.pdf', '%PDF-1.7', 'application/pdf');
    expect(doc.latest.reader).toEqual({ state: 'queued', thumbnail: false });
    const res = await get(member(kim), `${base}/reader`);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'not-ready', reader: { state: 'queued' } });
    expect((await get(member(kim), `${base}/thumbnail`)).statusCode).toBe(409);
    expect((await get(member(kim), `/v1/libraries/${doc.library}/documents/${doc.id}/versions/2/reader`)).statusCode).toBe(404);
  });

  it('serves the reader copy, its pictures, a thumbnail and the text, never as a page', async () => {
    const { get, upload, render } = await setup();
    const { doc, base } = await upload(member(alex), 'Travel.pdf', '%PDF-1.7', 'application/pdf');
    await render(doc.latest.id);

    const reader = await get(member(kim), `${base}/reader`);
    expect(reader.statusCode).toBe(200);
    expect(reader.body).toBe('# Travel\n\n![](images/1.png)\n');
    expect(reader.headers).toMatchObject({
      'content-type': 'text/markdown; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "sandbox; default-src 'none'",
      'cache-control': 'private, no-store',
    });
    const image = await get(member(kim), `${base}/reader/images/1.png`);
    expect([image.statusCode, image.headers['content-type'], image.body]).toEqual([200, 'image/png', 'png']);
    expect((await get(member(kim), `${base}/reader/images/2.png`)).statusCode).toBe(404);
    expect((await get(member(kim), `${base}/reader/images/..%2Freader.md`)).statusCode).toBe(400);
    expect((await get(member(kim), `${base}/thumbnail`)).body).toBe('thumb');
    const text = await get(member(kim), `${base}/text`);
    expect([text.headers['content-type'], text.body]).toEqual(['text/plain; charset=utf-8', 'Travel']);
    // Someone on another floor can't reach it at all.
    expect((await get(member(kim, 'w-legal'), `${base}/reader`)).statusCode).toBe(404);
    const opened = (await get(member(kim), `/v1/libraries/${doc.library}/documents/${doc.id}`)).json();
    expect(opened.versions[0].reader).toEqual({ state: 'ready', pages: 2, thumbnail: true, engine: 'docling 2.14.0' });
  });

  it('lets whoever may change the document ask again for a reader copy that failed', async () => {
    const { store, post, upload } = await setup();
    const { doc, base } = await upload(member(alex), 'Travel.pdf', '%PDF-1.7', 'application/pdf');
    expect((await post(member(alex), `${base}/reader/retry`)).json()).toMatchObject({ error: 'not-failed' });
    await store.finishRendition(doc.latest.id, { state: 'failed', error: 'The file is damaged.' });
    expect((await post(member(kim), `${base}/reader/retry`)).statusCode).toBe(403);
    const again = await post(member(alex), `${base}/reader/retry`);
    expect([again.statusCode, again.json()]).toEqual([202, { state: 'queued', thumbnail: false }]);
    await store.finishRendition(doc.latest.id, { state: 'failed', error: 'Still damaged.' });
    expect((await post(lead(sam), `${base}/reader/retry`)).statusCode).toBe(202);
  });

  it('stands in for the worker under pnpm dev:app: Markdown is its own reader copy', async () => {
    const { store, objects, get, upload } = await setup();
    store.onQueued = devRenderer(store, objects);
    const md = await upload(member(alex), 'Notes.md', '# Notes\n\nHello', 'text/markdown');
    const pdf = await upload(member(alex), 'Travel.pdf', '%PDF-1.7', 'application/pdf');
    await expect.poll(async () => (await get(member(kim), `${md.base}/reader`)).body).toBe('# Notes\n\nHello');
    await expect.poll(async () => (await store.rendition(pdf.doc.latest.id))?.state).toBe('failed');
  });
});
