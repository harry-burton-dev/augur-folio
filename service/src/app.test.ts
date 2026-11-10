import {
  CALLER_TOKEN_HEADER,
  callerAudienceOf,
  callerCheckFor,
  callerHeaders,
  callerOfService,
  callerSigner,
  eventDeliveryKey,
  IDEMPOTENCY_KEY_HEADER,
  packageVersion,
  PART_EVENTS_PATH,
  readManifest,
  signDelegation,
  signedCallerHeaders,
  type DomainEvent,
} from '@augur/service-kit';
import { describe, expect, it } from 'vitest';
import { buildApp, retentionDaysOf } from './app.ts';
import { memoryEvents } from './events.ts';

const manifest = readManifest(import.meta.url);
const sam = { id: 'u1', name: 'Sam Okafor', departments: [], roles: [], workspace: { id: 'ws-team', kind: 'team' as const, role: 'member' as const } };
// The gateway's address inside the deployment: not loopback, which the service kit believes as it comes.
const fromGateway = '172.18.0.9';

/** The app as it runs behind the gateway: it believes only a caller the gateway signed for `app-<id>` (`callerAudienceOf`, on contract 3). */
const behindGateway = async () => {
  const gateway = callerSigner();
  const kept = memoryEvents();
  const app = await buildApp({ manifest, callers: callerCheckFor(gateway, callerAudienceOf(manifest)), events: kept });
  return { app, gateway, kept };
};

/** The caller the gateway signs when the shell calls the app for a person (contract 3): the person, with the app and its scopes. */
const delegated = async (gateway: ReturnType<typeof callerSigner>) => ({
  [CALLER_TOKEN_HEADER]: await signDelegation(gateway, sam, { app: manifest.id, scopes: (manifest.scopes as string[] | undefined) ?? [] }),
});

const event: DomainEvent = { seq: '41', topic: 'platform.team.renamed', id: 'e41', publisher: 'identity', at: '2026-11-09T09:00:00Z', payload: { team: 'ws-team' } };

describe('the service', () => {
  it('answers /healthz with its release, with no one calling', async () => {
    const { app } = await behindGateway();
    const res = await app.inject({ remoteAddress: fromGateway, method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', version: packageVersion(import.meta.url), api: 'v1' });
  });

  it('refuses Home to a caller nobody signed, as a problem details body', async () => {
    const { app } = await behindGateway();
    const unsigned = await app.inject({ remoteAddress: fromGateway, method: 'GET', url: '/v1/home' });
    expect(unsigned.statusCode).toBe(401);
    expect(unsigned.headers['content-type']).toMatch(/application\/problem\+json/);
    // Plain x-user-* headers are anyone's word: dropped, so nobody is calling.
    const forged = await app.inject({ remoteAddress: fromGateway, method: 'GET', url: '/v1/home', headers: callerHeaders(sam) });
    expect(forged.statusCode).toBe(401);
  });

  it('answers Home for the floor the gateway signed, with nothing on it yet', async () => {
    const { app, gateway } = await behindGateway();
    const res = await app.inject({ remoteAddress: fromGateway, method: 'GET', url: '/v1/home', headers: await delegated(gateway) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ floor: { id: 'ws-team', kind: 'team' }, needsYou: [], latest: [] });
  });

  it('refuses a caller signed for another service', async () => {
    const { app, gateway } = await behindGateway();
    const res = await app.inject({ remoteAddress: fromGateway, method: 'GET', url: '/v1/home', headers: await signedCallerHeaders(gateway, sam, 'identity') });
    expect(res.statusCode).toBe(401);
  });

  it('keeps deleted documents for the days the admin gave, else the manifest’s default, and stops on a bad one', () => {
    const declared = (manifest.contributes as { settings: { id: string; default: number }[] }).settings.find((s) => s.id === 'retentionDays')!;
    expect(retentionDaysOf(manifest, {})).toBe(declared.default);
    expect(retentionDaysOf(manifest, { RETENTION_DAYS: '90' })).toBe(90);
    expect(() => retentionDaysOf(manifest, { RETENTION_DAYS: '0' })).toThrow(/whole number of days/);
    expect(() => retentionDaysOf(manifest, { RETENTION_DAYS: '2.5' })).toThrow(/whole number of days/);
  });

  it('serves its OpenAPI document where the manifest says', async () => {
    const { app } = await behindGateway();
    const res = await app.inject({ remoteAddress: fromGateway, method: 'GET', url: `/${(manifest.api as { openapi: string }).openapi}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ openapi: expect.stringMatching(/^3\./), info: { title: manifest.name, version: packageVersion(import.meta.url) } });
    expect(Object.keys(res.json().paths)).toContain('/v1/home');
  });
});

describe('events AUGUR pushes to the part', () => {
  const deliver = async (app: Awaited<ReturnType<typeof buildApp>>, headers: Record<string, string>) =>
    app.inject({ remoteAddress: fromGateway, method: 'POST', url: PART_EVENTS_PATH, headers, payload: event });

  it('keeps each event once, however often it is delivered', async () => {
    const { app, gateway, kept } = await behindGateway();
    const headers = { ...(await signedCallerHeaders(gateway, callerOfService('events'), callerAudienceOf(manifest))), [IDEMPOTENCY_KEY_HEADER]: eventDeliveryKey(event) };
    const first = await deliver(app, headers);
    const again = await deliver(app, headers);
    expect(first.statusCode).toBe(204);
    expect(again.statusCode).toBe(204);
    expect(kept.all()).toEqual([{ key: eventDeliveryKey(event), event }]);
  });

  it('takes events only from AUGUR’s events service', async () => {
    const { app, gateway, kept } = await behindGateway();
    const key = { [IDEMPOTENCY_KEY_HEADER]: eventDeliveryKey(event) };
    const person = await deliver(app, { ...(await delegated(gateway)), ...key });
    const another = await deliver(app, { ...(await signedCallerHeaders(gateway, callerOfService('identity'), callerAudienceOf(manifest))), ...key });
    const nobody = await deliver(app, key);
    const malformed = await app.inject({ remoteAddress: fromGateway, method: 'POST', url: PART_EVENTS_PATH, headers: { ...(await delegated(gateway)), ...key }, payload: { nothing: true } });
    expect([person.statusCode, another.statusCode, nobody.statusCode, malformed.statusCode]).toEqual([403, 403, 401, 403]);
    expect(kept.all()).toEqual([]);
  });

  it('needs the idempotency key to keep an event once', async () => {
    const { app, gateway, kept } = await behindGateway();
    const res = await deliver(app, await signedCallerHeaders(gateway, callerOfService('events'), callerAudienceOf(manifest)));
    expect(res.statusCode).toBe(400);
    expect(kept.all()).toEqual([]);
  });
});
