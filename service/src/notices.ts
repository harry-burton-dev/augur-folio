import { appCredentialsFromEnv, notify, type NotificationAction } from '@augur/service-kit';

/** Something Folio tells people through the shell's stream, on the floor it happened on. */
export interface FolioNotice {
  recipients: string[];
  workspace: string;
  title: string;
  detail?: string;
  /** Path inside Folio to open. */
  link?: string;
  actions?: NotificationAction[];
}

export type Notify = (notice: FolioNotice) => Promise<void>;

/** The most people one notification goes to; a larger audience is told in turns. */
const PER_CALL = 500;

/**
 * Tells people as Folio (the `notifications:send` scope), or, with no
 * EVENTS_URL or sign-in as under `pnpm dev:app`, only writes it in Folio's log.
 */
export const notifyFromEnv = (log: (notice: FolioNotice) => void, env = process.env): Notify => {
  const credentials = appCredentialsFromEnv('folio', env);
  const eventsUrl = env.EVENTS_URL;
  if (!eventsUrl || !credentials) return async (notice) => log(notice);
  return async ({ recipients, workspace, ...notice }) => {
    for (let i = 0; i < recipients.length; i += PER_CALL)
      await notify({ eventsUrl, credentials, workspace, notification: { app: 'folio', level: 'info', recipients: recipients.slice(i, i + PER_CALL), ...notice } });
  };
};
