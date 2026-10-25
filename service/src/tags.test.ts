import { callerHeaders, type Caller } from '@augur/service-kit';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { MemoryObjectStore } from './objects.ts';
import { MemoryFolioStore } from './store.ts';

const sam: Caller = { id: 'u-sam', name: 'Sam Okafor', departments: [], roles: [] };
const alex: Caller = { id: 'u-alex', name: 'Alex Rivera', departments: [], roles: [] };
const kim: Caller = { id: 'u-kim', name: 'Kim Lee', departments: [], roles: [] };
const lead = (who: Caller, floor = 'w-fin'): Caller => ({ ...who, workspace: { id: floor, kind: 'team', role: 'lead' } });
const member = (who: Caller, floor = 'w-fin'): Caller => ({ ...who, workspace: { id: floor, kind: 'team', role: 'member' } });
const orgLead = (who: Caller): Caller => ({ ...who, workspace: { id: 'w-org', kind: 'org', role: 'lead' } });

const setup = async () => {
  const app = await buildApp({ store: new MemoryFolioStore(), objects: new MemoryObjectStore(), audit: async () => {} });
  const json = (caller: Caller, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: callerHeaders(caller), ...(payload ? { payload } : {}) });
  const upload = (caller: Caller, url: string, body = '%PDF-1.7', type = 'application/pdf') =>
    app.inject({ method: 'POST', url, headers: { ...callerHeaders(caller), 'content-type': type }, payload: body });
  const { id: library } = (await json(lead(sam), 'POST', '/v1/libraries', { name: 'Policies' })).json();
  return { app, json, upload, library };
};

describe('folio tags', () => {
  it('lets only the org’s leads, on the org’s floor, keep the org’s tags; anyone can read them', async () => {
    const { json } = await setup();
    expect((await json(lead(sam), 'POST', '/v1/tags', { name: 'Policy' })).statusCode).toBe(403);
    const made = await json(orgLead(kim), 'POST', '/v1/tags', { name: ' Policy ' });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ name: 'Policy', workspace: 'w-org' });
    expect(made.json().library).toBeUndefined();
    expect((await json(orgLead(kim), 'POST', '/v1/tags', { name: 'policy' })).statusCode).toBe(409);
    const read = await json(member(alex), 'GET', '/v1/tags');
    expect(read.json()).toMatchObject({ tags: [{ name: 'Policy' }], can: { manage: false } });
    expect((await json(orgLead(kim), 'GET', '/v1/tags')).json().can.manage).toBe(true);
    const id = made.json().id;
    expect((await json(lead(sam), 'PATCH', `/v1/tags/${id}`, { name: 'Policies' })).statusCode).toBe(403);
    expect((await json(orgLead(kim), 'PATCH', `/v1/tags/${id}`, { name: 'Policies' })).json().name).toBe('Policies');
    expect((await json(orgLead(kim), 'DELETE', `/v1/tags/${id}`)).statusCode).toBe(204);
    expect((await json(orgLead(kim), 'DELETE', `/v1/tags/${id}`)).statusCode).toBe(404);
  });

  it('lets a library’s leads keep its tags, and anyone add them once it takes free tags', async () => {
    const { json, library } = await setup();
    expect((await json(member(alex), 'POST', `/v1/libraries/${library}/tags`, { name: 'Travel' })).statusCode).toBe(403);
    const travel = (await json(lead(sam), 'POST', `/v1/libraries/${library}/tags`, { name: 'Travel' })).json();
    expect(travel).toMatchObject({ name: 'Travel', library, workspace: 'w-fin' });
    expect((await json(member(alex), 'GET', `/v1/libraries/${library}`)).json()).toMatchObject({ freeTags: false, can: { addTags: false, manage: false } });
    expect((await json(member(alex), 'PATCH', `/v1/libraries/${library}`, { freeTags: true })).statusCode).toBe(403);
    expect((await json(lead(sam), 'PATCH', `/v1/libraries/${library}`, { freeTags: true })).json().freeTags).toBe(true);
    expect((await json(member(alex), 'GET', `/v1/libraries/${library}`)).json().can.addTags).toBe(true);
    expect((await json(member(alex), 'POST', `/v1/libraries/${library}/tags`, { name: 'Expenses' })).statusCode).toBe(201);
    // Free tags let people add them; changing and removing them stays with the leads.
    expect((await json(member(alex), 'PATCH', `/v1/libraries/${library}/tags/${travel.id}`, { name: 'Trips' })).statusCode).toBe(403);
    expect((await json(lead(sam), 'PATCH', `/v1/libraries/${library}/tags/${travel.id}`, { name: 'Trips' })).json().name).toBe('Trips');
    expect((await json(member(alex), 'DELETE', `/v1/libraries/${library}/tags/${travel.id}`)).statusCode).toBe(403);
    expect((await json(lead(sam), 'DELETE', `/v1/libraries/${library}/tags/${travel.id}`)).statusCode).toBe(204);
    // A library's address is no way to reach the org's tags.
    const org = (await json(orgLead(kim), 'POST', '/v1/tags', { name: 'Policy' })).json();
    expect((await json(lead(sam), 'DELETE', `/v1/libraries/${library}/tags/${org.id}`)).statusCode).toBe(404);
    expect((await json(lead(sam), 'POST', `/v1/libraries/${library}/tags`, { name: 'policy' })).json()).toMatchObject({ error: 'name-taken', message: 'Policy is already one of the org’s tags.' });
    const open = (await json(member(alex), 'GET', `/v1/libraries/${library}`)).json();
    expect(open.tags.map((t: { name: string }) => t.name)).toEqual(['Expenses', 'Policy']);
  });

  it('tags documents as they are uploaded, and after, by whoever may change them', async () => {
    const { json, upload, library } = await setup();
    const travel = (await json(lead(sam), 'POST', `/v1/libraries/${library}/tags`, { name: 'Travel' })).json();
    const policy = (await json(orgLead(kim), 'POST', '/v1/tags', { name: 'Policy' })).json();
    const other = (await json(lead(sam), 'POST', '/v1/libraries', { name: 'Other' })).json();
    const theirs = (await json(lead(sam), 'POST', `/v1/libraries/${other.id}/tags`, { name: 'Theirs' })).json();

    const bad = await upload(member(alex), `/v1/libraries/${library}/documents?filename=a.pdf&tag=${theirs.id}`);
    expect([bad.statusCode, bad.json().error]).toEqual([400, 'bad-tag']);
    const res = await upload(member(alex), `/v1/libraries/${library}/documents?filename=Trips.pdf&tag=${travel.id}`);
    expect(res.statusCode).toBe(201);
    const doc = res.json();
    expect(doc.tags).toEqual([travel.id]);
    const url = `/v1/libraries/${library}/documents/${doc.id}/tags`;
    expect((await json(member(kim), 'PUT', url, { tags: [policy.id] })).statusCode).toBe(403);
    expect((await json(member(alex), 'PUT', url, { tags: [theirs.id] })).json().error).toBe('bad-tag');
    const tagged = await json(member(alex), 'PUT', url, { tags: [policy.id, travel.id] });
    expect(tagged.json()).toMatchObject({ tags: [policy.id, travel.id].sort(), can: { change: true } });
    expect((await json(lead(sam), 'PUT', url, { tags: [] })).json().tags).toEqual([]);
    expect((await json(member(alex), 'GET', `/v1/libraries/${library}`)).json().authors).toEqual([{ id: 'u-alex', name: 'Alex Rivera' }]);
  });

  it('lists documents by tag, kind, author and time, everywhere below a place, sorted and counted', async () => {
    const { json, upload, library } = await setup();
    const hr = (await json(member(alex), 'POST', `/v1/libraries/${library}/folders`, { name: 'HR' })).json();
    const draft = (await json(lead(sam), 'POST', `/v1/libraries/${library}/tags`, { name: 'Draft' })).json();
    // Apart, so newest-first has an order to keep.
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
    await upload(member(alex), `/v1/libraries/${library}/documents?filename=Conduct.pdf`);
    await tick();
    await upload(member(kim), `/v1/libraries/${library}/documents?filename=Hiring.md&folder=${hr.id}&tag=${draft.id}`, '# Hiring', 'text/markdown');
    await tick();
    await upload(member(alex), `/v1/libraries/${library}/documents?filename=Leave.pdf&folder=${hr.id}&tag=${draft.id}`);
    const list = async (query: string) => {
      const res = await json(member(alex), 'GET', `/v1/libraries/${library}/documents?${query}`);
      return { titles: res.json().documents?.map((d: { title: string }) => d.title), total: res.json().total, status: res.statusCode };
    };
    expect(await list('')).toEqual({ titles: ['Conduct'], total: 1, status: 200 });
    expect(await list('below=true')).toMatchObject({ titles: ['Conduct', 'Hiring', 'Leave'], total: 3 });
    expect(await list(`folder=${hr.id}`)).toMatchObject({ titles: ['Hiring', 'Leave'] });
    expect(await list(`below=true&tag=${draft.id}`)).toMatchObject({ titles: ['Hiring', 'Leave'] });
    expect(await list('below=true&type=markdown')).toMatchObject({ titles: ['Hiring'] });
    expect(await list('below=true&type=markdown&type=pdf')).toMatchObject({ total: 3 });
    expect(await list('below=true&author=u-alex')).toMatchObject({ titles: ['Conduct', 'Leave'] });
    expect(await list('below=true&since=week')).toMatchObject({ total: 3 });
    expect(await list(`below=true&from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).toMatchObject({ total: 0 });
    expect(await list('below=true&to=2001-01-01')).toMatchObject({ total: 0 });
    expect(await list('below=true&sort=newest&limit=2')).toMatchObject({ titles: ['Leave', 'Hiring'], total: 3 });
    expect((await list('from=yesterday')).status).toBe(400);
    expect((await list('type=pptx')).status).toBe(400);
    expect((await list('sort=size')).status).toBe(400);
  });

  it('saves views in a library for everyone there, changed by whoever saved them or a lead', async () => {
    const { json, library } = await setup();
    const res = await json(member(alex), 'POST', `/v1/libraries/${library}/views`, { name: 'Recent PDFs', query: { types: ['pdf'], since: 'month', sort: 'updated' } });
    expect(res.statusCode).toBe(201);
    const view = res.json();
    expect(view).toMatchObject({ name: 'Recent PDFs', library, createdBy: 'u-alex', query: { types: ['pdf'], since: 'month', sort: 'updated' } });
    expect((await json(member(kim), 'POST', `/v1/libraries/${library}/views`, { name: 'recent pdfs', query: {} })).statusCode).toBe(409);
    expect((await json(member(kim), 'POST', `/v1/libraries/${library}/views`, { name: 'Bad', query: { sort: 'size' } })).statusCode).toBe(400);
    expect((await json(member(kim), 'GET', `/v1/libraries/${library}`)).json().views.map((v: { name: string }) => v.name)).toEqual(['Recent PDFs']);
    const url = `/v1/libraries/${library}/views/${view.id}`;
    expect((await json(member(kim), 'PATCH', url, { name: 'Mine now' })).statusCode).toBe(403);
    expect((await json(member(alex), 'PATCH', url, { name: 'PDFs this month' })).json().name).toBe('PDFs this month');
    expect((await json(member(kim), 'DELETE', url)).statusCode).toBe(403);
    expect((await json(lead(sam), 'DELETE', url)).statusCode).toBe(204);
    expect((await json(lead(sam), 'DELETE', url)).statusCode).toBe(404);
    // A view on another floor is as good as not there.
    expect((await json(lead(sam, 'w-legal'), 'POST', `/v1/libraries/${library}/views`, { name: 'X', query: {} })).statusCode).toBe(404);
  });
});
