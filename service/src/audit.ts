import { auditFor } from '@augur/service-kit';
import { manifest } from './manifest.ts';

/** Something Folio puts in the platform's audit log: who did what to which thing, on which floor. */
export interface FolioAuditEntry {
  actor: string;
  /** Who the actor is: a person (the default), or Folio itself doing its own work. */
  actorKind?: 'user' | 'service';
  action: string;
  target: string;
  workspace: string;
  detail?: Record<string, unknown>;
}

export type Audit = (entry: FolioAuditEntry) => Promise<void>;

/**
 * Writes to the platform's audit log as Folio (the `audit:write` scope), or, with no
 * EVENTS_URL or sign-in as under `pnpm dev:app`, only to Folio's own log.
 */
export const auditFromEnv = (log: (entry: FolioAuditEntry) => void, env = process.env): Audit => auditFor(manifest.id, (entry) => log(entry as FolioAuditEntry), env);
