import { createHash } from 'node:crypto';
import { callerHeaders, type Caller } from '@augur/service-kit';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import type { FolioAuditEntry } from './audit.ts';
import { titleFrom } from './documents.ts';
import { MemoryObjectStore } from './objects.ts';
import { MemoryFolioStore } from './store.ts';

const sam: Caller = { id: 'u-sam', name: 'Sam Okafor', departments: [], roles: [] };
const alex: Caller = { id: 'u-alex', name: 'Alex Rivera', departments: [], roles: [] };
const kim: Caller = { id: 'u-kim', name: 'Kim Lee', departments: [], roles: [] };
const lead = (who: Caller, floor = 'w-fin'): Caller => ({ ...who, workspace: { id: floor, kind: 'team', role: 'lead' } });
const member = (who: Caller, floor = 'w-fin'): Caller => ({ ...who, workspace: { id: floor, kind: 'team', role: 'member' } });

const PDF = 'application/pdf';
const sha = (body: string | Buffer) => createHash('sha256').update(body).digest('hex');

const setup = async ({ auditFails = false, maxUploadBytes = undefined as number | undefined } = {}) => {
  const objects = new MemoryObjectStore();
  const audited: FolioAuditEntry[] = [];
  const app = await buildApp({
    store: new MemoryFolioStore(),
    objects,
    maxUploadBytes,
    audit: async (entry) => {
      if (auditFails) throw new Error('events is down');
      audited.push(entry);
    },
  });
  const json = (caller: Caller, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: callerHeaders(caller), ...(payload ? { payload } : {}) });
  const send = (caller: Caller, url: string, body: string | Buffer, type = PDF) =>
    app.inject({ method: 'POST', url, headers: { ...callerHeaders(caller), 'content-type': type }, payload: body });
  const { id: library } = (await json(lead(sam), 'POST', '/v1/libraries', { name: 'Policies' })).json();
  return { app, objects, audited, json, send, library };
};

describe('folio documents', () => {
  it('takes a title from a file’s name', () => {
    expect(titleFrom('Travel policy v3.pdf')).toBe('Travel policy v3');
    expect(titleFrom('.pdf')).toBe('.pdf');
  });

  it('uploads a document from anyone on the floor, hashed and on the record', async () => {
    const { send, json, objects, audited, library } = await setup();
    const res = await send(member(alex), `/v1/libraries/${library}/documents?filename=${encodeURIComponent('Travel policy.pdf')}`, '%PDF-1.7 travel');
    expect(res.statusCode).toBe(201);
    const doc = res.json();
    expect(doc).toMatchObject({ title: 'Travel policy', createdBy: 'u-alex', latest: { number: 1, filename: 'Travel policy.pdf', mediaType: PDF, size: 15, sha256: sha('%PDF-1.7 travel') }, can: { change: true } });
    expect([...objects.files.keys()]).toEqual([`documents/${doc.id}/${doc.latest.id}`]);
    expect(audited.at(-1)).toMatchObject({ actor: 'u-alex', action: 'document.uploaded', target: doc.id, workspace: 'w-fin', detail: { version: 1, size: 15 } });
    const listed = (await json(member(kim), 'GET', `/v1/libraries/${library}/documents`)).json();
    expect(listed.documents.map((d: { title: string; can: object }) => [d.title, d.can])).toEqual([['Travel policy', { change: false, share: false }]]);
  });

  it('puts a document in a folder of the library, with the title given', async () => {
    const { send, json, library } = await setup();
    const hr = (await json(lead(sam), 'POST', `/v1/libraries/${library}/folders`, { name: 'HR' })).json();
    const doc = (await send(member(alex), `/v1/libraries/${library}/documents?filename=leave.md&title=Annual%20leave&folder=${hr.id}`, '# Leave', 'text/markdown; charset=utf-8')).json();
    expect(doc).toMatchObject({ title: 'Annual leave', folder: hr.id, latest: { mediaType: 'text/markdown' } });
    expect((await json(member(alex), 'GET', `/v1/libraries/${library}/documents?folder=${hr.id}`)).json().documents).toHaveLength(1);
    expect((await json(member(alex), 'GET', `/v1/libraries/${library}/documents`)).json().documents).toHaveLength(0);
    expect((await send(member(alex), `/v1/libraries/${library}/documents?filename=x.md&folder=nope`, '# X', 'text/markdown')).json().error).toBe('bad-parent');
  });

  it('takes only the kinds of file it can read, and nothing empty', async () => {
    const { send, objects, library } = await setup();
    const at = `/v1/libraries/${library}/documents`;
    expect((await send(member(alex), `${at}?filename=deck.pptx`, 'x', 'application/vnd.openxmlformats-officedocument.presentationml.presentation')).statusCode).toBe(415);
    expect((await send(member(alex), `${at}?filename=report.docx`, 'x', PDF)).statusCode).toBe(415);
    expect((await send(member(alex), `${at}?filename=notes.txt`, 'hello', 'text/plain')).statusCode).toBe(201);
    expect((await send(member(alex), `${at}?filename=a%2Fb.pdf`, 'x')).statusCode).toBe(400);
    expect((await send(member(alex), `${at}?filename=empty.pdf`, '')).json().error).toBe('empty');
    expect(objects.files.size).toBe(1);
  });

  it('adds versions from whoever added the document or a lead, and serves each original on the record', async () => {
    const { send, json, app, audited, library } = await setup();
    const doc = (await send(member(alex), `/v1/libraries/${library}/documents?filename=travel.pdf`, 'version one')).json();
    const at = `/v1/libraries/${library}/documents/${doc.id}`;
    expect((await send(member(kim), `${at}/versions?filename=travel.pdf`, 'kim was here')).statusCode).toBe(403);
    expect((await send(member(alex), `${at}/versions?filename=travel%20v2.pdf`, 'version two')).json()).toMatchObject({ number: 2, filename: 'travel v2.pdf' });
    expect((await send(lead(sam), `${at}/versions?filename=travel.html`, '<p>three</p>', 'text/html')).json()).toMatchObject({ number: 3, mediaType: 'text/html' });
    const opened = (await json(member(kim), 'GET', at)).json();
    expect(opened.latest.number).toBe(3);
    expect(opened.versions.map((v: { number: number }) => v.number)).toEqual([3, 2, 1]);
    expect(opened.can).toEqual({ change: false, share: false, publish: false, moves: [] });
    const original = await app.inject({ method: 'GET', url: `${at}/versions/2/original`, headers: callerHeaders(member(kim)) });
    expect(original.statusCode).toBe(200);
    expect(original.body).toBe('version two');
    expect(original.headers).toMatchObject({ 'content-type': PDF, 'content-length': '11', 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store' });
    expect(original.headers['content-disposition']).toBe(`attachment; filename="travel v2.pdf"; filename*=UTF-8''travel%20v2.pdf`);
    expect(audited.at(-1)).toMatchObject({ actor: 'u-kim', action: 'document.downloaded', target: doc.id, detail: { version: 2 } });
    expect(audited.map((a) => a.action)).toEqual(['library.created', 'document.uploaded', 'document.version-added', 'document.version-added', 'document.downloaded']);
    expect((await app.inject({ method: 'GET', url: `${at}/versions/9/original`, headers: callerHeaders(member(kim)) })).statusCode).toBe(404);
  });

  it('stops an upload past the limit and keeps none of it', async () => {
    const { send, objects, library } = await setup({ maxUploadBytes: 1024 * 1024 });
    const res = await send(member(alex), `/v1/libraries/${library}/documents?filename=big.pdf`, Buffer.alloc(1024 * 1024 + 1));
    expect(res.statusCode).toBe(413);
    expect(res.json().message).toBe('A file can be 1 MB at most.');
    expect(objects.files.size).toBe(0);
    expect((await send(member(alex), `/v1/libraries/${library}/documents?filename=fits.pdf`, Buffer.alloc(1024 * 1024))).statusCode).toBe(201);
  });

  it('gives no original while the audit log can’t take it', async () => {
    const { send, app, library } = await setup({ auditFails: true });
    const doc = (await send(member(alex), `/v1/libraries/${library}/documents?filename=travel.pdf`, 'version one')).json();
    expect(doc.latest.number).toBe(1);
    const res = await app.inject({ method: 'GET', url: `/v1/libraries/${library}/documents/${doc.id}/versions/1/original`, headers: callerHeaders(member(alex)) });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('audit-unavailable');
  });

  it('retitles, moves and deletes, for whoever added it or a lead', async () => {
    const { send, json, audited, library } = await setup();
    const hr = (await json(lead(sam), 'POST', `/v1/libraries/${library}/folders`, { name: 'HR' })).json();
    const doc = (await send(member(alex), `/v1/libraries/${library}/documents?filename=leave.pdf`, 'leave')).json();
    const at = `/v1/libraries/${library}/documents/${doc.id}`;
    expect((await json(member(kim), 'PATCH', at, { title: 'Mine' })).statusCode).toBe(403);
    expect((await json(member(alex), 'PATCH', at, { title: 'Annual leave', folder: hr.id })).json()).toMatchObject({ title: 'Annual leave', folder: hr.id });
    expect((await json(member(alex), 'DELETE', `/v1/libraries/${library}/folders/${hr.id}`)).statusCode).toBe(403);
    expect((await json(lead(sam), 'DELETE', `/v1/libraries/${library}/folders/${hr.id}`)).json().error).toBe('not-empty');
    expect((await json(member(alex), 'PATCH', at, { folder: null })).json().folder).toBeUndefined();
    expect((await json(member(kim), 'DELETE', at)).statusCode).toBe(403);
    expect((await json(lead(sam), 'DELETE', at)).statusCode).toBe(204);
    expect((await json(lead(sam), 'GET', at)).statusCode).toBe(404);
    expect(audited.at(-1)).toMatchObject({ actor: 'u-sam', action: 'document.deleted', target: doc.id });
  });

  it('keeps documents to the library and floor they are on', async () => {
    const { send, json, library } = await setup();
    const doc = (await send(member(alex), `/v1/libraries/${library}/documents?filename=travel.pdf`, 'travel')).json();
    const other = (await json(lead(sam), 'POST', '/v1/libraries', { name: 'Other' })).json();
    expect((await json(member(alex), 'GET', `/v1/libraries/${other.id}/documents/${doc.id}`)).statusCode).toBe(404);
    expect((await json(lead(sam, 'w-legal'), 'GET', `/v1/libraries/${library}/documents/${doc.id}`)).statusCode).toBe(404);
    expect((await send(lead(sam, 'w-legal'), `/v1/libraries/${library}/documents?filename=sneaky.pdf`, 'x')).statusCode).toBe(404);
  });
});
