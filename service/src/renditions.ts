import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { API_VERSION } from './app.ts';
import type { ObjectStore } from './objects.ts';
import { render, type Rendered } from './render.ts';
import type { RenditionTask, Store } from './store.ts';

/**
 * The worker part's loop (score/worker.score.yaml): takes the oldest reader copy that is due from the
 * queue in Artifacts' own schema, makes it from the original in the bucket, and keeps what it made beside
 * the original. One at a time; more instances share the queue, since each takes a row with SKIP LOCKED.
 */

export interface WorkerLog {
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

export interface RenditionWorkerOptions {
  store: Store;
  objects: ObjectStore;
  log: WorkerLog;
  /** Where to work on a file: the part's scratch folder. */
  scratchDir?: string;
  /** How long a worker holds a copy before another may take it, in seconds. */
  leaseSeconds?: number;
  /** How long to wait when nothing is due. */
  idleMs?: number;
  /** How long each converter may run. */
  timeoutMs?: number;
  /** Stands in for the converters in tests. */
  renderer?: typeof render;
}

/** Where a version's reader copy and pictures are kept in the bucket. */
export const renditionKey = (task: Pick<RenditionTask, 'document' | 'version'>, name: string) => `renditions/${task.document}/${task.version}/${name}`;

/** The path a version's picture is fetched at, under the app's own API (the kit's `readerPicturePath`). */
export const picturePath = (task: Pick<RenditionTask, 'document' | 'number'>, name: string) => `${API_VERSION}/documents/${task.document}/versions/${task.number}/pictures/${encodeURIComponent(name)}`;

/** What people are told when a try fails; what went wrong goes to the log. */
export const FAILED_WHY = 'Artifacts couldn’t make a copy to read here. Download the original to open it, or ask again.';

export const renditionWorker = ({ store, objects, log, scratchDir, leaseSeconds = 600, idleMs = 5000, timeoutMs, renderer = render }: RenditionWorkerOptions) => {
  const keep = async (task: RenditionTask, made: Extract<Rendered, { kind: 'ready' }>) => {
    const readerKey = renditionKey(task, 'reader.md');
    await objects.put(readerKey, Readable.from([Buffer.from(made.markdown, 'utf8')]), 'text/markdown; charset=utf-8');
    let thumbnailKey: string | undefined;
    if (made.thumbnail) {
      thumbnailKey = renditionKey(task, 'thumbnail.png');
      await objects.put(thumbnailKey, Readable.from([made.thumbnail]), 'image/png');
    }
    const pictureKeys: string[] = [];
    for (const p of made.pictures) {
      const key = renditionKey(task, `pictures/${p.name}`);
      await objects.put(key, Readable.from([p.body]), p.contentType);
      pictureKeys.push(key);
    }
    return { readerKey, ...(thumbnailKey ? { thumbnailKey } : {}), pictureKeys };
  };

  /** Makes one reader copy, if one is due. Answers whether there was one. */
  const once = async (): Promise<boolean> => {
    const task = await store.takeRendition(leaseSeconds);
    if (!task) return false;
    const started = Date.now();
    const dir = await mkdtemp(join(scratchDir ?? tmpdir(), 'rendition-'));
    try {
      const body = await objects.get(task.objectKey);
      if (!body) {
        await store.finishRendition(task, { state: 'none', why: 'The original can’t be found in storage, so there’s nothing to read. An admin can check the app’s bucket.' });
        log.warn({ version: task.version, key: task.objectKey }, 'the original is missing from the bucket');
        return true;
      }
      const file = join(dir, 'original');
      await pipeline(body, createWriteStream(file));
      const made = await renderer({ file, filename: task.filename, mediaType: task.mediaType, dir, picturePath: (name) => picturePath(task, name), ...(timeoutMs ? { timeoutMs } : {}) });
      const kept = made.kind === 'ready' ? await store.finishRendition(task, { state: 'ready', text: made.text, ...(made.pages ? { pages: made.pages } : {}), ...(await keep(task, made)) }) : await store.finishRendition(task, { state: 'none', why: made.why });
      if (!kept) log.warn({ version: task.version }, 'another worker took this reader copy over; leaving it to that one');
      else log.info({ version: task.version, state: made.kind, ms: Date.now() - started, tries: task.tries }, 'made a reader copy');
    } catch (err) {
      log.error({ version: task.version, tries: task.tries, err: (err as Error).message }, 'could not make a reader copy');
      await store.failRendition(task, FAILED_WHY).catch((e: Error) => log.error({ err: e.message }, 'could not record the failed try'));
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    return true;
  };

  /** Works until `signal` aborts: straight on while copies are due, waiting `idleMs` when none are. */
  const run = async (signal: AbortSignal) => {
    let wait = idleMs;
    while (!signal.aborted) {
      try {
        const worked = await once();
        wait = idleMs;
        if (worked) continue;
      } catch (err) {
        // The database is away: wait longer each time, up to a minute.
        log.error({ err: (err as Error).message }, 'could not reach the queue');
        wait = Math.min(wait * 2, 60_000);
      }
      await sleep(wait, undefined, { signal }).catch(() => undefined);
    }
  };

  return { once, run };
};
