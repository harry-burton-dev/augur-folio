import { describe, expect, it } from 'vitest';
import { DATABASE_URL, testDatabase } from './db.testing.ts';
import { hamid, lead, lucia, setUpApp, tomas } from './app.testing.ts';

const db = testDatabase('folio_links_test');

/** Two procedures in one folder, and a weekly notices series beside them. */
const twoDocuments = async () => {
  const s = await setUpApp(db);
  const collection = (await s.as(lead).call('POST', '/folders', { name: 'Procedures' })).json();
  const folder = (await s.as(tomas).call('POST', '/folders', { parent: collection.id, name: 'Berths' })).json();
  const old = (await s.as(tomas).upload(`/folders/${folder.id}/documents?filename=berth-2025.pdf`, '%PDF-1.7 old')).json();
  const now = (await s.as(tomas).upload(`/folders/${folder.id}/documents?filename=berth-2026.pdf`, '%PDF-1.7 new')).json();
  const series = (await s.as(tomas).call('POST', '/folders', { parent: collection.id, name: 'Weekly notices', level: 'series' })).json();
  return { s, collection, folder, old, now, series };
};

describe.skipIf(!DATABASE_URL)('links and follows', () => {
  it('links one document to another, read both ways, and lists the kinds it can’t make yet with why', async () => {
    const { s, old, now } = await twoDocuments();
    expect((await s.as(lucia).call('POST', `/documents/${now.id}/links`, { relation: 'supersedes', to: { id: old.id } })).statusCode).toBe(403);
    expect((await s.as(tomas).call('POST', `/documents/${now.id}/links`, { relation: 'about', to: { id: old.id } })).json()).toMatchObject({ reason: 'unavailable' });
    expect((await s.as(tomas).call('POST', `/documents/${now.id}/links`, { relation: 'supersedes', to: { id: now.id } })).json()).toMatchObject({ reason: 'bad_link' });
    const made = await s.as(tomas).call('POST', `/documents/${now.id}/links`, { relation: 'supersedes', to: { id: old.id } });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ words: 'Supersedes', to: { id: old.id, label: 'berth 2025' } });
    expect((await s.as(tomas).call('POST', `/documents/${now.id}/links`, { relation: 'supersedes', to: { id: old.id } })).json()).toMatchObject({ reason: 'already_linked' });

    const links = (await s.as(lucia).call('GET', `/documents/${now.id}/links`)).json();
    expect(links.can).toMatchObject({ change: false, why: expect.any(String) });
    expect(links.kinds.filter((k: { available: boolean }) => !k.available).map((k: { id: string; why: string }) => [k.id, typeof k.why])).toEqual([
      ['about', 'string'],
      ['serves', 'string'],
    ]);
    expect((await s.as(lucia).call('GET', `/documents/${old.id}/links`)).json().back).toEqual([expect.objectContaining({ words: 'Superseded by', from: expect.objectContaining({ id: now.id, label: 'berth 2026' }) })]);
    expect((await s.as(hamid).call('GET', `/documents/${now.id}/links`)).statusCode).toBe(404);

    expect((await s.as(tomas).call('DELETE', `/documents/${now.id}/links/${made.json().id}`)).statusCode).toBe(204);
    expect((await s.as(tomas).call('GET', `/documents/${now.id}/links`)).json().links).toEqual([]);
  });

  it('keeps a link to a document the caller can’t open listed, saying so', async () => {
    const { s, old, now } = await twoDocuments();
    await s.as(tomas).call('POST', `/documents/${now.id}/links`, { relation: 'relates-to', to: { id: old.id } });
    // Hamid is let into the new one only.
    await s.as(lead).call('PUT', '/grants', { kind: 'document', record: now.id, principal: 'person:u-hamid', level: 'read' });
    const links = (await s.as(hamid).call('GET', `/documents/${now.id}/links`)).json().links;
    expect(links).toEqual([expect.objectContaining({ words: 'Relates to', to: expect.objectContaining({ id: old.id, unavailable: expect.stringContaining('isn’t shared with you') }) })]);
  });

  it('tells a series’ followers of each new issue, and only a series can be followed', async () => {
    const { s, folder, series } = await twoDocuments();
    expect((await s.as(lucia).call('PUT', `/folders/${folder.id}/follow`, { on: true })).json()).toMatchObject({ reason: 'not_series' });
    expect((await s.as(lucia).call('PUT', `/folders/${series.id}/follow`, { on: true })).json()).toEqual({ following: true, followers: 1 });
    expect((await s.as(lucia).call('GET', `/folders/${series.id}`)).json().follow).toEqual({ following: true, followers: 1 });
    const issue = (await s.as(tomas).upload(`/folders/${series.id}/documents?filename=notice-46.pdf`, '%PDF-1.7 notice')).json();
    expect(s.notices).toEqual([]);
    await s.as(lead).call('POST', `/documents/${issue.id}/versions/1/state`, { to: 'issued' });
    await new Promise((r) => setTimeout(r, 20));
    expect(s.notices).toEqual([expect.objectContaining({ kind: 'issue', recipients: ['u-lucia'], link: `/documents/${issue.id}`, title: 'A new issue of Weekly notices: notice 46' })]);
    expect((await s.as(lucia).call('PUT', `/folders/${series.id}/follow`, { on: false })).json()).toEqual({ following: false, followers: 0 });
  });
});
