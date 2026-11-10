import type { Migration } from '@augur/service-kit';

/**
 * The app's schema, in order. The `migrate` part (score/migrate.score.yaml) runs them before each
 * install switches over, and a failing one leaves the old version serving. Once one has shipped it
 * never changes: add the next one instead, written so the version before still works with it.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: '001_kept_events',
    sql: `create table kept_events (
      key text primary key,
      seq text not null,
      topic text not null,
      event jsonb not null,
      kept_at timestamptz not null default now()
    )`,
  },
  {
    id: '002_library',
    sql: `
      -- Each floor has one library (the spec's D1): its collections are the top of it. A row is made the
      -- first time someone opens Artifacts on the floor. Every table below carries the floor it belongs to.
      create table floors (
        workspace_id text primary key,
        kind text not null check (kind in ('personal', 'team', 'org')),
        -- Anyone who may tag a document here may make new tags too.
        free_tags boolean not null default false,
        created_at timestamptz not null default now()
      );
      -- Collection › subcollection › series › subseries; a document is a file in one of them.
      create table folders (
        id text primary key,
        workspace_id text not null references floors (workspace_id),
        parent_id text references folders (id),
        level text not null check (level in ('collection', 'subcollection', 'series', 'subseries')),
        name text not null,
        description text not null default '',
        state text not null default 'open' check (state in ('open', 'closed', 'archived')),
        created_by text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        check ((level = 'collection') = (parent_id is null))
      );
      -- One name per place: collections compare with each other, the rest with their siblings.
      create unique index folders_name on folders (workspace_id, coalesce(parent_id, ''), lower(name));
      create index folders_parent on folders (parent_id);
      create table documents (
        id text primary key,
        workspace_id text not null references floors (workspace_id),
        folder_id text not null references folders (id),
        title text not null,
        title_words tsvector generated always as (to_tsvector('simple', title)) stored,
        created_by text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        deleted_by text,
        deleted_at timestamptz,
        -- When a deleted document's files left the bucket, past the retention setting's days.
        purged_at timestamptz
      );
      create index documents_folder on documents (folder_id, updated_at desc) where deleted_at is null;
      create index documents_title_words on documents using gin (title_words);
      create index documents_purgeable on documents (deleted_at) where deleted_at is not null and purged_at is null;
      -- Every file as it was uploaded. A version's file never changes; its place in its life does.
      create table document_versions (
        id text primary key,
        workspace_id text not null,
        document_id text not null references documents (id),
        number integer not null,
        filename text not null,
        media_type text not null,
        size_bytes bigint not null,
        sha256 text not null,
        object_key text not null,
        state text not null default 'in-progress' check (state in ('in-progress', 'in-review', 'complete', 'issued', 'retired')),
        created_by text not null,
        created_at timestamptz not null default now(),
        unique (document_id, number)
      );
      create index versions_review on document_versions (workspace_id) where state = 'in-review';
      -- Every lifecycle move, of a folder or a document's version, kept for good.
      create table state_moves (
        id bigint generated always as identity primary key,
        workspace_id text not null,
        record_id text not null,
        version_number integer,
        from_state text,
        to_state text not null,
        moved_by text not null,
        moved_at timestamptz not null default now(),
        note text
      );
      create index state_moves_record on state_moves (record_id, id desc);
      -- The org's tags have no floor; a floor's tags are its own. One of each name in each.
      create table tags (
        id text primary key,
        workspace_id text,
        name text not null,
        created_by text not null,
        created_at timestamptz not null default now()
      );
      create unique index tags_name on tags (coalesce(workspace_id, ''), lower(name));
      create table document_tags (
        document_id text not null references documents (id),
        tag_id text not null references tags (id),
        primary key (document_id, tag_id)
      );
      create index document_tags_tag on document_tags (tag_id);
      -- A folder's tags count for everything inside it when filtering.
      create table folder_tags (
        folder_id text not null references folders (id),
        tag_id text not null references tags (id),
        primary key (folder_id, tag_id)
      );
      create index folder_tags_tag on folder_tags (tag_id);
      -- People and teams let into the floor's library, a folder (and all inside it) or one document,
      -- until AUGUR's permissions service takes grants (the spec's D9).
      create table grants (
        workspace_id text not null references floors (workspace_id),
        record_kind text not null check (record_kind in ('library', 'folder', 'document')),
        record_id text not null,
        principal text not null check (principal ~ '^((person|team|tree):.+|org)$'),
        level text not null check (level in ('read', 'edit', 'manage')),
        created_by text not null,
        created_at timestamptz not null default now(),
        primary key (record_id, principal)
      );
      create index grants_principal on grants (principal);
      create index grants_floor on grants (workspace_id);
      -- The name each person had when they last did something here, to show them by.
      create table people (
        id text primary key,
        name text not null,
        seen_at timestamptz not null default now()
      );
      -- When each person last looked at Home on a floor, so it can say what's new since.
      create table looked (
        person_id text not null,
        workspace_id text not null,
        at timestamptz not null,
        primary key (person_id, workspace_id)
      );
      -- What the org calls a level instead of Artifacts' own name.
      create table level_names (
        level text primary key check (level in ('collection', 'subcollection', 'series', 'subseries', 'file')),
        name text not null,
        plural text not null,
        updated_by text not null,
        updated_at timestamptz not null default now()
      );`,
  },
  {
    id: '003_renditions',
    sql: `
      -- Each version's reader copy, made by the worker part (score/worker.score.yaml) without ML models (the
      -- spec's D3). A row is queued in the same transaction as its version; the worker takes the oldest one
      -- it may with SKIP LOCKED, holds it for a lease, and tries three times. \`none\` means there's no reader
      -- copy for that kind of file, and \`why\` says so to whoever opens it.
      create table renditions (
        version_id text primary key references document_versions (id),
        workspace_id text not null,
        document_id text not null references documents (id),
        state text not null default 'queued' check (state in ('queued', 'working', 'ready', 'failed', 'none')),
        tries integer not null default 0,
        -- Not before: a try that failed waits a while before the next.
        queued_at timestamptz not null default now(),
        lease_until timestamptz,
        finished_at timestamptz,
        why text,
        pages integer,
        reader_key text,
        thumbnail_key text,
        picture_keys text[] not null default '{}',
        -- The words of its text, for Find.
        text_words tsvector
      );
      create index renditions_waiting on renditions (queued_at) where state in ('queued', 'working');
      create index renditions_words on renditions using gin (text_words);`,
  },
  {
    id: '004_placements',
    sql: `
      -- Publishing up the floors (the spec's section 4, \`@augur/records\` placements): a folder or a document
      -- put on a floor above its own through a filter of lifecycle states, as a live window onto it. Floors
      -- are named as placements name them: a team's or someone's own floor by its workspace id, the org as
      -- \`org\`. A floor that received it may publish it further up (\`via\`), never showing more. Taking one
      -- back ends it, and every one that came up through it; ended rows stay, for the record.
      create table placements (
        id text primary key,
        -- The floor the record is kept on.
        workspace_id text not null references floors (workspace_id),
        record_kind text not null check (record_kind in ('folder', 'document')),
        record_id text not null,
        from_floor text not null,
        to_floor text not null,
        -- Who on that floor sees it: \`tree:<team>\`, or \`org\`.
        to_principal text not null,
        filter text[] not null,
        via text references placements (id),
        -- Where its receiving floor's leads put it in their library; none while it waits under From below.
        landed_folder text references folders (id) on delete set null,
        note text,
        placed_by text not null,
        placed_at timestamptz not null default now(),
        ended_at timestamptz,
        ended_by text,
        ended_reason text
      );
      create index placements_record on placements (record_id);
      create index placements_to on placements (to_floor) where ended_at is null;
      create index placements_landed on placements (landed_folder) where ended_at is null;
      -- One live window per record and floor.
      create unique index placements_live on placements (record_id, to_floor) where ended_at is null;`,
  },
];
