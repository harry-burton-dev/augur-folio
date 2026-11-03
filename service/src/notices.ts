import { notifyFor, type NotificationAction } from '@augur/service-kit';
import { manifest } from './manifest.ts';

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

/**
 * Tells people as Folio (the `notifications:send` scope), or, with no
 * EVENTS_URL or sign-in as under `pnpm dev:app`, only writes it in Folio's log.
 */
export const notifyFromEnv = (log: (notice: FolioNotice) => void, env = process.env): Notify => notifyFor(manifest.id, log, env);
