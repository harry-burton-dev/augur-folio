import { describe, expect, it } from 'vitest';
import { DATABASE_URL, testDatabase } from './db.testing.ts';
import { amara, hamid, lead, lucia, owen, setUpApp, tomas } from './app.testing.ts';

const db = testDatabase('folio_placements_test');

/** Port Services' berth procedure: version 1 Issued, version 2 In progress. Operations has a Procedures collection. */
const anIssuedProcedure = async () => {
  const s = await setUpApp(db);
  const collection = (await s.as(lead).call('POST', '/folders', { name: 'Procedures' })).json();
  const folder = (await s.as(tomas).call('POST', '/folders', { parent: collection.id, name: 'Berths' })).json();
  const document = (await s.as(tomas).upload(`/folders/${folder.id}/documents?filename=berth.pdf`, '%PDF-1.7 one')).json();
  expect((await s.as(lead).call('POST', `/documents/${document.id}/versions/1/state`, { to: 'issued' })).statusCode).toBe(200);
  expect((await s.as(tomas).upload(`/documents/${document.id}/versions?filename=berth.pdf`, '%PDF-1.7 two')).statusCode).toBe(201);
  const ops = (await s.as(amara).call('POST', '/folders', { name: 'Procedures' })).json();
  return { s, collection, folder, document, ops };
};

describe.skipIf(!DATABASE_URL)('publishing up', () => {
  it('lists every floor above, with why for any it can’t reach, and publishes to one', async () => {
    const { s, document } = await anIssuedProcedure();
    const before = (await s.as(lead).call('GET', `/placements?kind=document&record=${document.id}`)).json();
    expect(before).toMatchObject({ own: { id: 'w-port', name: 'Port Services' }, owner: { id: 'w-port' }, placements: [] });
    expect(before.targets.map((t: { to: { name: string }; why?: string }) => [t.to.name, t.why])).toEqual([
      ['Operations', undefined],
      ['The org', expect.stringContaining('publisher role')],
    ]);
    // Only whoever manages it publishes it, and never to a floor beside its own.
    expect((await s.as(tomas).call('POST', '/placements', { record: { kind: 'document', id: document.id }, to: 'w-ops' })).statusCode).toBe(403);
    expect((await s.as(lead).call('POST', '/placements', { record: { kind: 'document', id: document.id }, to: 'w-finance' })).json()).toMatchObject({ reason: 'bad_placement' });
    expect((await s.as(lead).call('POST', '/placements', { record: { kind: 'document', id: document.id }, to: 'org' })).json()).toMatchObject({ reason: 'publisher_only' });

    const placed = await s.as(lead).call('POST', '/placements', { record: { kind: 'document', id: document.id }, to: 'w-ops' });
    expect(placed.statusCode).toBe(201);
    expect(placed.json()).toMatchObject({ from: { name: 'Port Services' }, to: { name: 'Operations' }, filter: ['complete', 'issued'], record: { name: 'berth', level: 'file' } });
    expect((await s.as(lead).call('POST', '/placements', { record: { kind: 'document', id: document.id }, to: 'w-ops' })).json()).toMatchObject({ reason: 'bad_placement' });
    // Operations is told, and not whoever published it.
    await new Promise((r) => setTimeout(r, 20));
    expect(s.notices).toEqual([expect.objectContaining({ kind: 'published', link: '/below', recipients: expect.arrayContaining(['u-amara', 'u-owen']) })]);
    expect(s.notices[0]!.recipients).not.toContain('u-lead');
    const after = (await s.as(lead).call('GET', `/placements?kind=document&record=${document.id}`)).json();
    expect(after.owner).toMatchObject({ id: 'w-ops' });
    expect(after.targets.find((t: { to: { id: string } }) => t.to.id === 'w-ops').why).toBe('It’s already there.');
  });

  it('shows it under From below, one version only, until its leads give it a place', async () => {
    const { s, document, ops } = await anIssuedProcedure();
    const placement = (await s.as(lead).call('POST', '/placements', { record: { kind: 'document', id: document.id }, to: 'w-ops' })).json();
    const below = (await s.as(owen).call('GET', '/received')).json();
    expect(below.here).toEqual([expect.objectContaining({ states: ['complete', 'issued'], version: expect.objectContaining({ number: 1, state: 'issued' }), placement: expect.objectContaining({ id: placement.id, can: expect.objectContaining({ land: false }) }) })]);
    expect(below.places).toEqual([]);
    expect((await s.as(amara).call('GET', '/received')).json().places).toEqual([{ id: ops.id, label: 'Procedures', level: 'collection' }]);
    expect((await s.as(amara).call('GET', '/home')).json().needsYou).toEqual([expect.objectContaining({ title: 'berth', path: '/below' })]);

    // Off its floor, the version Operations is shown, and nothing of the newer one.
    const opened = (await s.as(owen).call('GET', `/documents/${document.id}`)).json();
    expect(opened).toMatchObject({ reached: { placement: placement.id, floor: { name: 'Operations' }, version: 1 }, rights: { level: 'read', add: false }, next: [] });
    expect(opened.versions.map((v: { number: number }) => v.number)).toEqual([1]);
    expect(opened.document.latest.number).toBe(1);
    expect((await s.as(owen).call('GET', `/documents/${document.id}/versions/1/file`)).body).toBe('%PDF-1.7 one');
    expect((await s.as(owen).call('GET', `/documents/${document.id}/versions/2/file`)).statusCode).toBe(404);
    expect((await s.as(owen).call('POST', `/documents/${document.id}/versions/1/state`, { to: 'retired' })).json()).toMatchObject({ reason: 'bad_move' });
    // A floor beside it sees nothing.
    expect((await s.as(hamid).call('GET', `/documents/${document.id}`)).statusCode).toBe(404);

    expect((await s.as(owen).call('PUT', `/placements/${placement.id}/landing`, { folder: ops.id })).statusCode).toBe(403);
    expect((await s.as(amara).call('PUT', `/placements/${placement.id}/landing`, { folder: ops.id })).json()).toMatchObject({ landed: { folder: ops.id, name: 'Procedures' } });
    expect((await s.as(owen).call('GET', `/folders/${ops.id}`)).json().received).toEqual([expect.objectContaining({ placement: expect.objectContaining({ id: placement.id }) })]);
    expect((await s.as(amara).call('GET', '/home')).json().needsYou).toEqual([]);
  });

  it('keeps one place: the floor below shows a signpost to it', async () => {
    const { s, folder, document, ops } = await anIssuedProcedure();
    const placement = (await s.as(lead).call('POST', '/placements', { record: { kind: 'document', id: document.id }, to: 'w-ops' })).json();
    await s.as(amara).call('PUT', `/placements/${placement.id}/landing`, { folder: ops.id });
    // Port Services sits inside Operations, so Lucia's one place for it is there.
    const rows = (await s.as(lucia).call('GET', `/folders/${folder.id}/documents`)).json().documents;
    expect(rows[0].placed).toEqual({ placement: placement.id, to: expect.objectContaining({ id: 'w-ops', name: 'Operations' }), landed: 'Procedures' });
    expect((await s.as(lucia).call('GET', `/documents/${document.id}`)).json().document.placed).toMatchObject({ to: { name: 'Operations' } });
    // Its own floor still changes it.
    expect((await s.as(tomas).call('GET', `/documents/${document.id}`)).json().rights.add).toBe(true);
  });

  it('goes on up from the floor that received it, never showing more, and comes back down with it', async () => {
    const { s, document } = await anIssuedProcedure();
    const first = (await s.as(lead).call('POST', '/placements', { record: { kind: 'document', id: document.id }, to: 'w-ops', filter: ['issued'] })).json();
    const targets = (await s.as(amara).call('GET', `/placements?kind=document&record=${document.id}`)).json().targets;
    expect(targets).toEqual([expect.objectContaining({ from: expect.objectContaining({ id: 'w-ops' }), to: expect.objectContaining({ id: 'org' }), via: first.id, most: ['issued'] })]);
    expect((await s.as(amara).call('POST', '/placements', { record: { kind: 'document', id: document.id }, to: 'org', via: first.id, filter: ['complete', 'issued'] })).json()).toMatchObject({ reason: 'bad_placement' });
    const second = (await s.as(amara).call('POST', '/placements', { record: { kind: 'document', id: document.id }, to: 'org', via: first.id, filter: ['issued'] })).json();
    expect((await s.as(hamid).call('GET', `/documents/${document.id}`)).json().reached).toMatchObject({ placement: second.id, floor: { id: 'org' } });

    expect((await s.as(tomas).call('POST', `/placements/${first.id}/withdraw`, {})).statusCode).toBe(403);
    const withdrawn = (await s.as(lead).call('POST', `/placements/${first.id}/withdraw`, { reason: 'Superseded' })).json();
    expect(withdrawn.withdrawn.map((f: { id: string }) => f.id).sort()).toEqual(['org', 'w-ops']);
    expect((await s.as(hamid).call('GET', `/documents/${document.id}`)).statusCode).toBe(404);
    expect((await s.as(owen).call('GET', '/received')).json().here).toEqual([]);
  });

  it('opens a folder published up, at the states it shows', async () => {
    const { s, collection, folder } = await anIssuedProcedure();
    const draft = (await s.as(tomas).upload(`/folders/${folder.id}/documents?filename=draft.pdf`, '%PDF-1.7 draft')).json();
    const placement = (await s.as(lead).call('POST', '/placements', { record: { kind: 'folder', id: collection.id }, to: 'w-ops' })).json();
    const top = (await s.as(owen).call('GET', `/received/${placement.id}`)).json();
    expect(top).toMatchObject({ folder: { name: 'Procedures' }, path: [{ name: 'Procedures' }], documents: [], states: ['complete', 'issued'] });
    expect(top.folders.map((f: { name: string }) => f.name)).toEqual(['Berths']);
    const inside = (await s.as(owen).call('GET', `/received/${placement.id}?folder=${folder.id}`)).json();
    expect(inside.path.map((p: { name: string }) => p.name)).toEqual(['Procedures', 'Berths']);
    // The draft is In progress, so it doesn't show; the procedure shows at its Issued version.
    expect(inside.documents.map((d: { title: string; version: { number: number } }) => [d.title, d.version.number])).toEqual([['berth', 1]]);
    expect((await s.as(owen).call('GET', `/documents/${draft.id}`)).statusCode).toBe(404);
    expect((await s.as(hamid).call('GET', `/received/${placement.id}`)).statusCode).toBe(404);
    // A whole collection stays as it is under From below.
    const ops = (await s.as(amara).call('GET', '/received')).json().places[0];
    expect((await s.as(amara).call('PUT', `/placements/${placement.id}/landing`, { folder: ops.id })).json()).toMatchObject({ reason: 'bad_landing' });
  });
});
