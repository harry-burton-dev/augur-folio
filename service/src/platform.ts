import { appCredentialsFromEnv, inboxItem, updateInboxItem, type InboxChange, type NewInboxItem } from '@augur/service-kit';

/**
 * How the part reaches AUGUR's own services on contract 3: only through the gateway, signed in as the app
 * with the client the gateway resource gives it (score/web.score.yaml: `client_secret` as a file, the
 * `token_url`). index.ts turns those into the settings the service kit's clients read: EVENTS_URL and
 * IDENTITY_URL under the gateway's `/api/`, OIDC_TOKEN_URL and SERVICE_CLIENT_SECRET.
 */
export const platformEnv = (env: Record<string, string | undefined>) => {
  const gateway = env.GATEWAY_URL?.replace(/\/+$/, '');
  if (!gateway) return env;
  return {
    ...env,
    EVENTS_URL: env.EVENTS_URL ?? `${gateway}/api/events`,
    IDENTITY_URL: env.IDENTITY_URL ?? `${gateway}/api/identity`,
    ...(env.GATEWAY_TOKEN_URL && !env.OIDC_TOKEN_URL ? { OIDC_TOKEN_URL: env.GATEWAY_TOKEN_URL } : {}),
  };
};

/** Work that waits on someone, in AUGUR's Inbox (the `inbox:write` scope), keyed by the app's own id for it. */
export interface Inbox {
  put(key: string, workspace: string, item: NewInboxItem): Promise<void>;
  change(key: string, workspace: string, change: InboxChange): Promise<void>;
}

/** The Inbox through the gateway, or, without a sign-in (as under `pnpm dev:app`), only the log. */
export const inboxFor = (app: string, log: (line: Record<string, unknown>) => void, env: Record<string, string | undefined> = process.env): Inbox => {
  const credentials = appCredentialsFromEnv(app, env);
  const eventsUrl = env.EVENTS_URL;
  if (!eventsUrl || !credentials) return { put: async (key, workspace, item) => log({ inbox: { key, workspace, item } }), change: async (key, workspace, change) => log({ inbox: { key, workspace, change } }) };
  return {
    put: async (key, workspace, item) => void (await inboxItem({ eventsUrl, credentials, workspace, app, key, item })),
    change: async (key, workspace, change) => void (await updateInboxItem({ eventsUrl, credentials, workspace, app, key, change })),
  };
};

/** In memory, for tests. */
export const memoryInbox = () => {
  const items = new Map<string, NewInboxItem & { state: 'open' | 'done' | 'withdrawn'; workspace: string }>();
  return {
    items,
    async put(key: string, workspace: string, item: NewInboxItem) {
      items.set(key, { ...item, workspace, state: 'open' });
    },
    async change(key: string, _workspace: string, change: InboxChange) {
      const item = items.get(key);
      if (item && change.state) item.state = change.state;
    },
  } satisfies Inbox & { items: unknown };
};
