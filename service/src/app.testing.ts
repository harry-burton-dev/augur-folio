// What the route tests share: the app as the gateway would call it, and the seed's cast as far as they need it.
import { CALLER_TOKEN_HEADER, callerAudienceOf, callerCheckFor, callerSigner, readManifest, signDelegation, type AppNotice, type AppPeople, type Caller } from '@augur/service-kit';
import { buildApp } from './app.ts';
import { MemoryObjectStore } from './objects.ts';
import { memoryInbox } from './platform.ts';
import type { Store } from './store.ts';

export const manifest = readManifest(import.meta.url);
const fromGateway = '172.18.0.9';

type Floor = { id: string; kind: 'personal' | 'team' | 'org'; role: 'member' | 'lead' };
const port: Floor = { id: 'w-port', kind: 'team', role: 'member' };
export const person = (id: string, name: string, workspace: Floor, roles: string[] = []): Caller => ({ id, name, departments: [], roles, workspace });
// The seed's cast, as far as these tests need it: a lead and an editor of one team, a reader, and someone on another floor.
export const lead = person('u-lead', 'Ada Lead', { ...port, role: 'lead' });
export const tomas = person('u-tomas', 'Tomas Lindqvist', port, ['editor']);
export const lucia = person('u-lucia', 'Lucia Ferreira', port);
export const hamid = person('u-hamid', 'Hamid Sadeghi', { id: 'w-finance', kind: 'team', role: 'member' }, ['editor']);
// Port Services sits inside Operations, whose lead publishes for the org.
export const amara = person('u-amara', 'Amara Okafor', { id: 'w-ops', kind: 'team', role: 'lead' }, ['publisher']);
export const owen = person('u-owen', 'Owen Pryce', { id: 'w-ops', kind: 'team', role: 'member' });

const TEAMS = [
  { id: 'w-ops', name: 'Operations', within: [], path: ['w-ops'] },
  { id: 'w-port', name: 'Port Services', within: ['Operations'], path: ['w-ops', 'w-port'] },
  { id: 'w-finance', name: 'Finance', within: [], path: ['w-finance'] },
];
const MEMBERS: Record<string, string> = { 'u-lead': 'w-port', 'u-tomas': 'w-port', 'u-lucia': 'w-port', 'u-hamid': 'w-finance', 'u-amara': 'w-ops', 'u-owen': 'w-ops' };

/** Someone's principals: themselves, their team, `tree:` for it and each team above it, and the org. */
const principalsOf = (id: string) => {
  const team = TEAMS.find((t) => t.id === MEMBERS[id]);
  return [`person:${id}`, ...(team ? [`team:${team.id}`, ...team.path.map((t) => `tree:${t}`)] : []), 'org'];
};

/** Identity, as far as these tests ask it. */
const people: AppPeople = {
  principals: async (id) => principalsOf(id),
  directory: async ({ q, ids }) => ({
    people: [hamid, tomas, lucia, amara, owen].filter((p) => (q ? p.name.toLowerCase().includes(q.toLowerCase()) : ids?.includes(p.id))).map((p) => ({ id: p.id, name: p.name })),
    teams: q ? [] : TEAMS.filter((t) => ids?.includes(t.id)),
  }),
  audience: async (principals) => Object.keys(MEMBERS).filter((id) => principalsOf(id).some((p) => principals.includes(p))),
};

/** The app on `db`'s store, and a way to call it as anyone. */
export const setUpApp = async (db: { store: Store }, maxUploadBytes?: number) => {
  const gateway = callerSigner();
  const objects = new MemoryObjectStore();
  const inbox = memoryInbox();
  const notices: AppNotice[] = [];
  const notify = async (notice: AppNotice) => void notices.push(notice);
  const app = await buildApp({ manifest, callers: callerCheckFor(gateway, callerAudienceOf(manifest)), store: db.store, objects, inbox, people, notify, ...(maxUploadBytes ? { maxUploadBytes } : {}) });
  const as = (caller: Caller) => {
    const headers = async () => ({ [CALLER_TOKEN_HEADER]: await signDelegation(gateway, caller, { app: manifest.id, scopes: (manifest.scopes as string[]) ?? [] }) });
    const call = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => app.inject({ remoteAddress: fromGateway, method, url: `/v1${url}`, headers: await headers(), ...(payload === undefined ? {} : { payload: payload as object }) });
    const upload = async (url: string, body: string | Buffer, type = 'application/pdf') => app.inject({ remoteAddress: fromGateway, method: 'POST', url: `/v1${url}`, headers: { ...(await headers()), 'content-type': type }, payload: body });
    return { call, upload };
  };
  return { app, objects, inbox, notices, as };
};
