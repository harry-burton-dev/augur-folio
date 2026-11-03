import pg from 'pg';
import type { Jobs, JobLogger } from '@augur/service-kit';
import type { FolioStore } from './store.ts';

/**
 * The renditions the worker (worker/, in Python) makes, queued as jobs it runs (`renditions` on the
 * queue `<app>.renditions`, ADR 0014). The `folio.renditions` row stays the record people see: a
 * version's row is written as `queued` in the same transaction as the version, and this hands every
 * queued row to the jobs. Each run's id names the row's version and when it was queued, so handing
 * a row over twice starts one run, and a rendition asked for again gets a new one.
 */
export const RENDITIONS_JOB = 'renditions';

/** The channel the store tells of each queued rendition on, once it has committed. */
const CHANNEL = 'folio_renditions';

export const runIdFor = (version: string, queuedAt: string) => `${RENDITIONS_JOB}-${version}-${Date.parse(queuedAt)}`;

export const renditionQueue = (store: FolioStore, jobs: Jobs, log: JobLogger) => {
  const job = jobs.elsewhere<{ version: string }>(RENDITIONS_JOB);
  let running: Promise<number> | undefined;
  let again = false;

  /** Hands every queued rendition to the worker. Returns how many it handed over this time. */
  const handOver = async (): Promise<number> => {
    let n = 0;
    for (const { version, queuedAt } of await store.queuedRenditions()) {
      await jobs.start(job, { version }, { id: runIdFor(version, queuedAt) });
      n++;
    }
    return n;
  };

  /** One hand-over at a time; a call during one runs another after it. */
  const sweep = (): Promise<number> => {
    if (running) {
      again = true;
      return running;
    }
    running = handOver()
      .catch((err: Error) => {
        log.error({ err: err.message }, 'could not hand renditions to the worker');
        return 0;
      })
      .finally(() => {
        running = undefined;
        if (again) {
          again = false;
          void sweep();
        }
      });
    return running;
  };

  /**
   * Hears of each version as it is queued, so the worker gets it at once. When the connection drops,
   * it listens again; the scheduled sweep catches anything missed meanwhile.
   */
  const listen = (databaseUrl: string) => {
    let stopped = false;
    let client: pg.Client | undefined;
    const connect = async (wait = 1000) => {
      if (stopped) return;
      client = new pg.Client({ connectionString: databaseUrl });
      client.on('notification', () => void sweep());
      client.on('error', (err) => {
        log.warn({ err: err.message }, 'lost the renditions channel; listening again');
        void client?.end().catch(() => undefined);
        setTimeout(() => void connect(Math.min(wait * 2, 30_000)), wait).unref();
      });
      try {
        await client.connect();
        await client.query(`listen ${CHANNEL}`);
        void sweep();
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'could not listen for renditions; trying again');
        setTimeout(() => void connect(Math.min(wait * 2, 30_000)), wait).unref();
      }
    };
    void connect();
    return async () => {
      stopped = true;
      await client?.end().catch(() => undefined);
    };
  };

  return { job, sweep, listen };
};
