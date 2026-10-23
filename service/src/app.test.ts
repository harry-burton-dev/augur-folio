import { callerCheckFor, callerHeaders, callerSigner, signedCallerHeaders, type Caller } from '@augur/service-kit';
import { describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { MemoryFolioStore } from './store.ts';

const sam: Caller = { id: 'u-sam', name: 'Sam Okafor', departments: [], roles: [] };
const alex: Caller = { id: 'u-alex', name: 'Alex Rivera', departments: [], roles: [] };
const lead = (who: Caller, floor = 'w-fin'): Caller => ({ ...who, workspace: { id: floor, kind: 'team', role: 'lead' } });
const member = (who: Caller, floor = 'w-fin'): Caller => ({ ...who, workspace: { id: floor, kind: 'team', role: 'member' } });

const setup = async () => {
  const app = await buildApp({ store: new MemoryFolioStore() });
  const call = (caller: Caller | undefined, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url, headers: caller ? callerHeaders(caller) : {}, ...(payload ? { payload } : {}) });
  return { app, call };
};

describe('folio', () => {
  it('reports healthy', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', service: 'folio', version: expect.stringMatching(/^\d+\.\d+\.\d+/), api: 'v1' });
  });

  it('needs someone signed in, on a floor', async () => {
    const { call } = await setup();
    expect((await call(undefined, 'GET', '/v1/libraries')).statusCode).toBe(401);
    const off = await call(sam, 'GET', '/v1/libraries');
    expect(off.statusCode).toBe(400);
    expect(off.json().error).toBe('floor-needed');
  });

  it('believes only the caller the gateway signed for it', async () => {
    const gateway = callerSigner();
    const app = await buildApp({ callers: callerCheckFor(gateway, 'folio') });
    const signed = await app.inject({ remoteAddress: '172.18.0.9', method: 'GET', url: '/v1/libraries', headers: await signedCallerHeaders(gateway, lead(sam), 'folio') });
    expect(signed.statusCode).toBe(200);
    const forged = await app.inject({ remoteAddress: '172.18.0.9', method: 'GET', url: '/v1/libraries', headers: callerHeaders(lead(sam)) });
    expect(forged.statusCode).toBe(401);
  });

  it('lets a floor’s leads make libraries, and everyone on it see them', async () => {
    const { call } = await setup();
    expect((await call(member(alex), 'POST', '/v1/libraries', { name: 'Policies' })).statusCode).toBe(403);
    const made = await call(lead(sam), 'POST', '/v1/libraries', { name: '  Policies ', description: 'How we work' });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ name: 'Policies', description: 'How we work', workspace: 'w-fin', createdBy: 'u-sam' });
    expect((await call(lead(sam), 'POST', '/v1/libraries', { name: 'policies' })).statusCode).toBe(409);
    expect((await call(lead(sam), 'POST', '/v1/libraries', { name: '   ' })).statusCode).toBe(400);
    const seen = await call(member(alex), 'GET', '/v1/libraries');
    expect(seen.json()).toMatchObject({ libraries: [{ name: 'Policies' }], can: { create: false } });
    expect((await call(lead(sam), 'GET', '/v1/libraries')).json().can).toEqual({ create: true });
  });

  it('keeps a library to its own floor', async () => {
    const { call } = await setup();
    const { id } = (await call(lead(sam), 'POST', '/v1/libraries', { name: 'Policies' })).json();
    expect((await call(lead(sam, 'w-legal'), 'GET', '/v1/libraries')).json().libraries).toEqual([]);
    expect((await call(lead(sam, 'w-legal'), 'GET', `/v1/libraries/${id}`)).statusCode).toBe(404);
    expect((await call(lead(sam, 'w-legal'), 'PATCH', `/v1/libraries/${id}`, { name: 'Mine now' })).statusCode).toBe(404);
    expect((await call(lead(sam, 'w-legal'), 'POST', `/v1/libraries/${id}/folders`, { name: 'Sneaky' })).statusCode).toBe(404);
  });

  it('opens a library with its folders and what the caller may do there', async () => {
    const { call } = await setup();
    const { id } = (await call(lead(sam), 'POST', '/v1/libraries', { name: 'Policies' })).json();
    const hr = (await call(member(alex), 'POST', `/v1/libraries/${id}/folders`, { name: 'HR' })).json();
    expect((await call(member(alex), 'POST', `/v1/libraries/${id}/folders`, { name: 'Leave', parent: hr.id })).statusCode).toBe(201);
    expect((await call(member(alex), 'POST', `/v1/libraries/${id}/folders`, { name: 'a/b' })).statusCode).toBe(400);
    expect((await call(member(alex), 'POST', `/v1/libraries/${id}/folders`, { name: 'X', parent: 'nope' })).json().error).toBe('bad-parent');
    const opened = await call(member(alex), 'GET', `/v1/libraries/${id}`);
    expect(opened.json()).toMatchObject({ name: 'Policies', can: { manage: false, addFolders: true } });
    expect(opened.json().folders.map((f: { name: string }) => f.name)).toEqual(['HR', 'Leave']);
  });

  it('lets leads rename and archive a library', async () => {
    const { call } = await setup();
    const { id } = (await call(lead(sam), 'POST', '/v1/libraries', { name: 'Policies' })).json();
    expect((await call(member(alex), 'PATCH', `/v1/libraries/${id}`, { name: 'Rules' })).statusCode).toBe(403);
    expect((await call(lead(sam), 'PATCH', `/v1/libraries/${id}`, {})).statusCode).toBe(400);
    expect((await call(lead(sam), 'PATCH', `/v1/libraries/${id}`, { name: 'Rules' })).json().name).toBe('Rules');
    expect((await call(member(alex), 'POST', `/v1/libraries/${id}/archive`)).statusCode).toBe(403);
    expect((await call(lead(sam), 'POST', `/v1/libraries/${id}/archive`)).statusCode).toBe(204);
    expect((await call(lead(sam), 'GET', `/v1/libraries/${id}`)).statusCode).toBe(404);
  });

  it('lets whoever made a folder, or a lead, rename or remove it, once it is empty', async () => {
    const { call } = await setup();
    const { id } = (await call(lead(sam), 'POST', '/v1/libraries', { name: 'Policies' })).json();
    const mine = (await call(member(alex), 'POST', `/v1/libraries/${id}/folders`, { name: 'Drafts' })).json();
    const theirs = (await call(lead(sam), 'POST', `/v1/libraries/${id}/folders`, { name: 'HR' })).json();
    await call(lead(sam), 'POST', `/v1/libraries/${id}/folders`, { name: 'Leave', parent: theirs.id });
    expect((await call(member(alex), 'PATCH', `/v1/libraries/${id}/folders/${theirs.id}`, { name: 'Mine' })).statusCode).toBe(403);
    expect((await call(member(alex), 'PATCH', `/v1/libraries/${id}/folders/${mine.id}`, { name: 'HR' })).statusCode).toBe(409);
    expect((await call(member(alex), 'PATCH', `/v1/libraries/${id}/folders/${mine.id}`, { name: 'Notes' })).json().name).toBe('Notes');
    expect((await call(lead(sam), 'DELETE', `/v1/libraries/${id}/folders/${theirs.id}`)).json().error).toBe('not-empty');
    expect((await call(lead(sam), 'DELETE', `/v1/libraries/${id}/folders/${mine.id}`)).statusCode).toBe(204);
    expect((await call(lead(sam), 'DELETE', `/v1/libraries/${id}/folders/${mine.id}`)).statusCode).toBe(404);
  });
});
