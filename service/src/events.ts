import { callerFromHeaders, IDEMPOTENCY_KEY_HEADER, PART_EVENTS_PATH, Problem, serviceOfCaller, type DomainEvent } from '@augur/service-kit';
import type { FastifyInstance } from 'fastify';

/**
 * The events AUGUR pushes to this part (contract 3; AUGUR's docs/domain-events.md, "Pushed to your part"):
 * `POST /augur/events` through the gateway, one event at a time and in order, signed as AUGUR's events
 * service, with an `Idempotency-Key` that is the same each time one event is sent. Answer 2xx once the
 * event is kept; anything else and it comes again, so the same key may arrive twice: keep it once.
 */

/** Where the part keeps what it was sent. `keep` says whether the key was new. */
export interface EventsKept {
  keep(key: string, event: DomainEvent): Promise<boolean>;
}

/** Kept in memory: for tests and `pnpm dev:app`, where the part has no database. Gone on a restart. */
export const memoryEvents = () => {
  const kept = new Map<string, DomainEvent>();
  return {
    async keep(key: string, event: DomainEvent) {
      if (kept.has(key)) return false;
      kept.set(key, event);
      return true;
    },
    all: () => [...kept].map(([key, event]) => ({ key, event })),
  };
};

/** What `postgresEvents` needs of a database connection: `pg`'s pools fit. */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rowCount: number | null }>;
}

/** Kept in the app's own schema (the `kept_events` table, migrations.ts): a key already there changes nothing. */
export const postgresEvents = (db: Queryable): EventsKept => ({
  async keep(key, event) {
    const { rowCount } = await db.query('insert into kept_events (key, seq, topic, event) values ($1, $2, $3, $4) on conflict (key) do nothing', [key, event.seq, event.topic, JSON.stringify(event)]);
    return rowCount === 1;
  },
});

/** The route: only AUGUR's events service may deliver, and each key is kept once. */
export const partEvents = async (app: FastifyInstance, { kept }: { kept: EventsKept }) => {
  app.post<{ Body: DomainEvent }>(
    PART_EVENTS_PATH,
    {
      // Who is calling is checked before the body, so a caller who may not deliver learns nothing about its shape.
      onRequest: async (req) => {
        const caller = callerFromHeaders(req.headers);
        if (!caller) throw new Problem(401, 'unauthorized', 'Events come signed by AUGUR’s events service.');
        if (serviceOfCaller(caller) !== 'events') throw new Problem(403, 'forbidden', 'Only AUGUR’s events service delivers events here.');
      },
      schema: { body: { type: 'object', required: ['seq', 'topic'], properties: { seq: { type: 'string' }, topic: { type: 'string' } } } },
    },
    async (req, reply) => {
      const key = req.headers[IDEMPOTENCY_KEY_HEADER];
      if (typeof key !== 'string' || !key) throw new Problem(400, 'bad_request', `An event comes with an ${IDEMPOTENCY_KEY_HEADER} header, so it is kept once.`);
      const fresh = await kept.keep(key, req.body);
      req.log.info({ key, topic: req.body.topic, fresh }, fresh ? 'event kept' : 'event already kept');
      return reply.code(204).send();
    },
  );
};
