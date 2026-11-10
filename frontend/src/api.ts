import type { AppContext } from '@augur/mfe-sdk/sdk3';
import { API, why } from './screen.js';

/** A call the service turned down, with the sentence it said why. */
export class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Artifacts' own service, through the gateway: `ctx.fetch` adds the person's token, the floor and the
 * app, so the worker never holds them. Every refusal comes back as problem details; its `detail` is
 * the sentence the screen shows.
 */
export const apiFor = (ctx: AppContext) => {
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await ctx.fetch(`${API}${path}`, init);
    if (!res.ok) throw new Refused(res.status, await why(res));
    return (res.status === 204 ? undefined : await res.json()) as T;
  };
  const send = <T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) =>
    call<T>(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
  return {
    get: <T>(path: string) => call<T>(path),
    send,
    /** A file as the request's body, its name in the query (the service streams it into the bucket). */
    upload: async <T>(path: string, file: File) => {
      const res = await ctx.files.upload(file, `${API}${path}${path.includes('?') ? '&' : '?'}filename=${encodeURIComponent(file.name)}`);
      if (!res.ok) throw new Refused(res.status, await why(res));
      return (await res.json()) as T;
    },
    /** Saves a version's original for the person, under its own name. */
    download: (path: string) => ctx.files.download(`${API}${path}`, { save: true }),
  };
};

export type Api = ReturnType<typeof apiFor>;
