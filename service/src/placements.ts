import { above, CONTENT_LIFECYCLE, floorRank, floorsAbove, ownerOf, placementRefusal, viewFor, type Placement as Step } from '@augur/records';
import { Problem, type AppAudit, type AppNotify, type AppPeople, type OnFloor } from '@augur/service-kit';
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from 'fastify';
import { documentLevel, folderLevel, pathTo, reaches, UNIT_LEVELS, type FloorAccess } from './access.ts';
import type { ContentState, FloorKind, FloorView, LandingPlace, PlacementsAnswer, PlacementView, PublishTarget, ReceivedAnswer, ReceivedItem, RecordKind, RecordRef, Signpost } from './api-types.ts';
import { PlacedError, type DocumentRecord, type FolderRecord, type PlacementRecord, type Store, type VersionRecord } from './store.ts';

/**
 * Publishing up the floors (spec section 4, `@augur/records` placements). A folder or a document is put
 * on a floor above its own through a filter of lifecycle states, as a live window onto it: what's added
 * later shows through too. The floor that received it may publish it further up, never showing more.
 * There is one owner, the highest floor it has reached. Each person sees it in one place only, the
 * highest floor that shows it to them; the floors below show a signpost to it.
 */

/** Publishing to the org needs this role from identity, which an admin gives. */
export const PUBLISHER_ROLE = 'publisher';
/** What a new placement shows when nobody says: what's finished. */
export const DEFAULT_FILTER: ContentState[] = ['complete', 'issued'];

/** A floor as placements name it: a team's or someone's own floor by its workspace id, the org as `org`. */
export const floorKeyOf = (workspace: string, kind: FloorKind) => (kind === 'org' ? 'org' : workspace);
export const callerFloor = (caller: OnFloor) => floorKeyOf(caller.workspace.id, caller.workspace.kind);
/** Who on a floor sees what is put on it. */
export const principalOfFloor = (floor: string) => (floor === 'org' ? 'org' : `tree:${floor}`);

/** The newest of these versions (newest first) in one of `states`. */
export const newestPassing = (versions: readonly VersionRecord[], states: readonly ContentState[]) => versions.find((v) => states.includes(v.state));

const PUBLISHER_ONLY = 'Publishing to the org needs the publisher role, which an admin can give you.';

/** A floor with the path of teams it sits in, which only the service needs. */
type Floor = FloorView & { path: string[] };
const wire = ({ path: _, ...f }: Floor): FloorView => f;

/** A record a placement can show, where it is kept. */
interface Held {
  ref: RecordRef;
  workspace: string;
  folder?: FolderRecord;
  document?: DocumentRecord;
}

export interface PlacingDeps {
  store: Store;
  people: AppPeople;
  notify: AppNotify;
  recorded: (entry: Parameters<AppAudit>[0]) => void;
  log: FastifyBaseLogger;
  callerOf: (req: FastifyRequest) => Promise<OnFloor>;
  principalsOf: (caller: OnFloor) => Promise<readonly string[]>;
  accessOn: (caller: OnFloor, workspace: string, principals?: readonly string[]) => Promise<FloorAccess>;
}

export const placing = ({ store, people, notify, recorded, log, callerOf, principalsOf, accessOn }: PlacingDeps) => {
  /** Where floors sit and what they are called: teams from the directory, the rest from the floors Artifacts keeps. */
  const floorsOf = async (keys: readonly string[], caller: OnFloor): Promise<Map<string, Floor>> => {
    const all = [...new Set(keys)];
    const others = all.filter((k) => k !== 'org');
    const [found, rows] = await Promise.all([
      others.length ? people.directory({ ids: others }).catch((err: Error) => (log.warn({ err: err.message }, 'could not name floors'), { people: [], teams: [] })) : { people: [], teams: [] },
      Promise.all(others.map(async (k) => [k, await store.floorRow(k)] as const)),
    ]);
    const teams = new Map(found.teams.map((t) => [t.id, t]));
    const kinds = new Map(rows.map(([k, r]) => [k, r?.kind]));
    const out = new Map<string, Floor>();
    for (const key of all) {
      const team = teams.get(key);
      const kind: FloorKind = key === 'org' ? 'org' : team ? 'team' : (kinds.get(key) ?? (caller.workspace.id === key ? caller.workspace.kind : 'personal'));
      if (kind === 'org') out.set(key, { id: 'org', kind, name: 'The org', rank: 0, path: [] });
      else if (kind === 'team') {
        const path = team?.path?.length ? team.path : [key];
        out.set(key, { id: key, kind, name: team?.name ?? (caller.workspace.id === key ? 'This team' : 'A team'), rank: floorRank({ kind, path }), path });
      } else out.set(key, { id: key, kind, name: caller.workspace.id === key ? 'Your own floor' : 'Someone’s own floor', rank: floorRank({ kind, path: [] }), path: [] });
    }
    return out;
  };

  const asStep = (p: PlacementRecord, floors: ReadonlyMap<string, Floor>): Step<ContentState> => ({
    id: p.id,
    record: p.record.id,
    from: p.from,
    to: p.to,
    rank: floors.get(p.to)?.rank ?? Number.MAX_SAFE_INTEGER,
    filter: p.filter,
    ...(p.via ? { via: p.via } : {}),
    by: p.by,
    at: p.at,
    ...(p.ended ? { endedAt: p.ended.at } : {}),
  });

  const held = async (kind: RecordKind, id: string): Promise<Held | undefined> => {
    if (kind === 'folder') {
      const folder = await store.folder(id);
      return folder && { ref: { kind, id, name: folder.name, level: folder.level }, workspace: folder.workspace, folder };
    }
    const document = await store.document(id);
    return document && { ref: { kind, id, name: document.title, level: 'file' }, workspace: document.workspace, document };
  };

  const ownKeyOf = async (workspace: string) => floorKeyOf(workspace, (await store.floorRow(workspace))?.kind ?? 'team');

  /** Whether the caller manages the record standing on its own floor: only from there is it published first. */
  const managesHere = async (caller: OnFloor, record: Held) => {
    if (caller.workspace.id !== record.workspace) return false;
    const access = await accessOn(caller, record.workspace);
    return reaches(record.document ? documentLevel(access, record.document) : folderLevel(access, record.ref.id), 'manage');
  };

  const leadsReceiving = (caller: OnFloor, p: PlacementRecord) => callerFloor(caller) === p.to && caller.workspace.role === 'lead';

  /** Who may take a step back: whoever published it, from its floor, or the leads of the floor it went to. */
  const mayWithdraw = async (caller: OnFloor, p: PlacementRecord, record: Held | undefined) => {
    if (leadsReceiving(caller, p)) return true;
    if (p.via) return callerFloor(caller) === p.from && caller.workspace.role === 'lead';
    return Boolean(record && (await managesHere(caller, record)));
  };

  const viewOf = async (p: PlacementRecord, caller: OnFloor, floors: ReadonlyMap<string, Floor>, record?: Held): Promise<PlacementView> => {
    const r = record ?? (await held(p.record.kind, p.record.id));
    const [landed, names] = await Promise.all([p.landed ? store.folder(p.landed) : undefined, store.names([p.by])]);
    const withdraw = !p.ended && (await mayWithdraw(caller, p, r));
    const land = !p.ended && leadsReceiving(caller, p);
    const unknown = (key: string): FloorView => ({ id: key, kind: 'team', name: 'A floor', rank: Number.MAX_SAFE_INTEGER });
    return {
      id: p.id,
      record: r?.ref ?? { kind: p.record.kind, id: p.record.id, name: 'Something no longer kept', level: p.record.kind === 'document' ? 'file' : 'collection' },
      from: floors.get(p.from) ? wire(floors.get(p.from)!) : unknown(p.from),
      to: floors.get(p.to) ? wire(floors.get(p.to)!) : unknown(p.to),
      filter: p.filter,
      ...(p.via ? { via: p.via } : {}),
      ...(landed ? { landed: { folder: landed.id, name: landed.name } } : {}),
      ...(p.note ? { note: p.note } : {}),
      by: p.by,
      ...(names.get(p.by) ? { byName: names.get(p.by) } : {}),
      at: p.at,
      ...(p.ended ? { ended: p.ended } : {}),
      can: { withdraw, land, ...(withdraw && land ? {} : { why: 'Whoever published it, or the leads of the floor it’s on, decide where it sits and can take it back.' }) },
    };
  };

  /**
   * The live placements that reach the caller and show a record: on it, or on a folder it is in. For a
   * document they say which version the caller may read off its own floor.
   */
  const covering = async (records: readonly string[], principals: readonly string[]) =>
    (await store.placementsOf(records)).filter((p) => !p.ended && principals.includes(p.toPrincipal));

  /** The ids a record is shown through: itself, and every folder above it. */
  const shownThrough = (access: FloorAccess, record: { id: string; folder?: string }) => [record.id, ...(record.folder ? pathTo(access.folders, record.folder).map((f) => f.id) : [])];

  /**
   * Where the caller's one place is for a record they can see on its own floor, when it is a floor above:
   * the signpost the floor below shows. Undefined while its place is here.
   */
  const signpostFor = async (caller: OnFloor, access: FloorAccess, record: { id: string; folder?: string }, reaching?: readonly PlacementRecord[]): Promise<Signpost | undefined> => {
    const steps = reaching ?? (await covering(shownThrough(access, record), access.principals));
    if (!steps.length) return undefined;
    const floors = await floorsOf(steps.map((p) => p.to), caller);
    const seen = viewFor(steps.map((p) => asStep(p, floors)));
    if (!seen || seen.place.to === callerFloor(caller)) return undefined;
    const place = steps.find((p) => p.id === seen.place.id)!;
    const landed = place.landed ? await store.folder(place.landed) : undefined;
    return { placement: place.id, to: wire(floors.get(place.to)!), ...(landed ? { landed: landed.name } : {}) };
  };

  /**
   * How far publishing up lets someone into a document they can't otherwise open: the newest version
   * any of their floors' placements lets through, and that one only.
   */
  const reachedVersion = async (caller: OnFloor, access: FloorAccess, document: DocumentRecord) => {
    const steps = await covering(shownThrough(access, document), access.principals);
    if (!steps.length) return undefined;
    const states = [...new Set(steps.flatMap((p) => p.filter))];
    const version = newestPassing(await store.versions(document.id), states);
    if (!version) return undefined;
    const floors = await floorsOf(steps.map((p) => p.to), caller);
    const place = viewFor(steps.map((p) => asStep(p, floors)))!.place;
    return { placement: place.id, floor: wire(floors.get(place.to)!), version: version.number };
  };

  /** Each list a floor shows of what it received: the record, the states the caller sees and, for a document, which version. */
  const receivedItem = async (p: PlacementRecord, caller: OnFloor, principals: readonly string[], floors: ReadonlyMap<string, Floor>): Promise<ReceivedItem | undefined> => {
    const record = await held(p.record.kind, p.record.id);
    if (!record || record.folder?.state === 'archived') return undefined;
    const reaching = await covering([p.record.id], principals);
    const states = CONTENT_LIFECYCLE.tidy([...new Set(reaching.flatMap((q) => q.filter))]);
    const version = record.document ? newestPassing(await store.versions(record.document.id), states) : undefined;
    if (record.document && !version) return undefined;
    const names = version ? await store.names([version.createdBy]) : new Map<string, string>();
    return {
      placement: await viewOf(p, caller, floors, record),
      states,
      ...(version
        ? {
            version: {
              number: version.number,
              filename: version.filename,
              mediaType: version.mediaType,
              size: version.size,
              state: version.state,
              createdBy: version.createdBy,
              ...(names.get(version.createdBy) ? { createdByName: names.get(version.createdBy) } : {}),
              createdAt: version.createdAt,
              ...(version.reader ? { reader: version.reader } : {}),
              thumbnail: version.thumbnail,
            },
          }
        : {}),
    };
  };

  /** Received records put in a folder on the caller's floor. */
  const receivedIn = async (caller: OnFloor, folder: string): Promise<ReceivedItem[]> => {
    const landed = await store.landedIn(folder);
    if (!landed.length) return [];
    const principals = await principalsOf(caller);
    const mine = landed.filter((p) => principals.includes(p.toPrincipal));
    const floors = await floorsOf(mine.flatMap((p) => [p.from, p.to]), caller);
    return (await Promise.all(mine.map((p) => receivedItem(p, caller, principals, floors)))).filter((i): i is ReceivedItem => Boolean(i));
  };

  /** What is waiting under From below for the floor's leads to give it a place, for Home. */
  const waiting = async (caller: OnFloor) => (caller.workspace.role === 'lead' ? (await store.placementsTo(callerFloor(caller), 50)).filter((p) => !p.landed) : []);

  const routes = async (app: FastifyInstance) => {
    const notFound = () => new Problem(404, 'not_found', 'There’s no such thing to publish, or it hasn’t been shared with you.');
    const gone = () => new Problem(404, 'not_found', 'It isn’t on that floor any more.');
    const ID = { type: 'string', minLength: 1, maxLength: 64 } as const;
    const FILTER = { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', enum: CONTENT_LIFECYCLE.states.map((s) => s.id) } } as const;
    const RECORD = { type: 'object', additionalProperties: false, required: ['kind', 'id'], properties: { kind: { type: 'string', enum: ['folder', 'document'] }, id: ID } } as const;
    const idParams = { type: 'object', required: ['id'], properties: { id: ID } } as const;

    /** Whether the caller can see a record at all: on its floor, by a grant, or through publishing up. */
    const sees = async (caller: OnFloor, record: Held, principals: readonly string[]) => {
      const access = await accessOn(caller, record.workspace, principals);
      if (record.document ? documentLevel(access, record.document) : folderLevel(access, record.ref.id)) return true;
      return (await covering(shownThrough(access, record.document ?? { id: record.ref.id, ...(record.folder?.parent ? { folder: record.folder.parent } : {}) }), principals)).length > 0;
    };

    /** Where the caller could publish a record next, each floor above with why when it can't be chosen. */
    const targetsFor = async (caller: OnFloor, record: Held, own: string, steps: readonly PlacementRecord[], principals: readonly string[]) => {
      const live = steps.filter((p) => !p.ended);
      const starts: { from: string; via?: PlacementRecord }[] = [];
      if (await managesHere(caller, record)) starts.push({ from: own });
      for (const p of live) if (leadsReceiving(caller, p)) starts.push({ from: p.to, via: p });
      if (!starts.length) return { targets: [] as PublishTarget[], floors: new Map<string, Floor>() };
      const from = await floorsOf(starts.map((s) => s.from), caller);
      const options = starts.flatMap((s) => {
        const at = from.get(s.from)!;
        return floorsAbove({ id: at.id, kind: at.kind, path: at.path }, at.kind === 'personal' ? principals : []).map((to) => ({ ...s, to }));
      });
      const floors = await floorsOf([...options.flatMap((o) => [o.from, o.to])], caller);
      const targets = options.map(({ from: f, to, via }): PublishTarget => {
        const why = live.some((p) => p.to === to) ? 'It’s already there.' : to === 'org' && !caller.roles.includes(PUBLISHER_ROLE) ? PUBLISHER_ONLY : undefined;
        return { from: wire(floors.get(f)!), to: wire(floors.get(to)!), ...(via ? { via: via.id, most: via.filter } : {}), ...(why ? { why } : {}) };
      });
      return { targets, floors };
    };

    app.get<{ Querystring: { kind: RecordKind; record: string } }>(
      '/placements',
      { schema: { querystring: { type: 'object', additionalProperties: false, required: ['kind', 'record'], properties: { kind: RECORD.properties.kind, record: ID } } } },
      async (req): Promise<PlacementsAnswer> => {
        const caller = await callerOf(req);
        const record = await held(req.query.kind, req.query.record);
        const principals = await principalsOf(caller);
        if (!record || !(await sees(caller, record, principals))) throw notFound();
        const steps = await store.placementsOf([record.ref.id]);
        const own = await ownKeyOf(record.workspace);
        const { targets } = await targetsFor(caller, record, own, steps, principals);
        const floors = await floorsOf([own, ...steps.flatMap((p) => [p.from, p.to])], caller);
        const owner = ownerOf(own, steps.map((p) => asStep(p, floors)));
        return {
          record: record.ref,
          own: wire(floors.get(own)!),
          owner: wire(floors.get(owner)!),
          placements: await Promise.all(steps.map((p) => viewOf(p, caller, floors, record))),
          targets,
        };
      },
    );

    app.post<{ Body: { record: { kind: RecordKind; id: string }; to: string; filter?: ContentState[]; via?: string; note?: string } }>(
      '/placements',
      { schema: { body: { type: 'object', additionalProperties: false, required: ['record', 'to'], properties: { record: RECORD, to: ID, filter: FILTER, via: ID, note: { type: 'string', maxLength: 500 } } } } },
      async (req, reply) => {
        const caller = await callerOf(req);
        const { to } = req.body;
        const filter = CONTENT_LIFECYCLE.tidy(req.body.filter ?? DEFAULT_FILTER);
        const record = await held(req.body.record.kind, req.body.record.id);
        if (!record) throw notFound();
        const via = req.body.via ? await store.placement(req.body.via) : undefined;
        if (req.body.via && (!via || via.record.id !== record.ref.id)) throw notFound();
        // From its own floor, by whoever manages it there; or on up from a floor that received it, by that floor's leads.
        if (via) {
          if (!leadsReceiving(caller, via)) throw new Problem(403, 'forbidden', 'Only the leads of the floor that received it can publish it further up, from that floor.', { whoCanChange: 'That floor’s leads.' });
        } else if (!(await managesHere(caller, record)))
          throw new Problem(403, 'forbidden', 'Only whoever manages it can publish it, from its own floor.', { whoCanChange: 'The floor’s leads, or someone they let manage it.' });
        if (to === 'org' && !caller.roles.includes(PUBLISHER_ROLE)) throw new Problem(403, 'publisher_only', PUBLISHER_ONLY, { whoCanChange: 'An admin.' });
        const own = await ownKeyOf(record.workspace);
        const fromKey = via ? via.to : own;
        const principals = await principalsOf(caller);
        const floors = await floorsOf([fromKey, to], caller);
        const from = floors.get(fromKey)!;
        const steps = await store.placementsOf([record.ref.id]);
        const refusal = placementRefusal({
          from: { id: from.id, kind: from.kind, path: from.path },
          to,
          principals: from.kind === 'personal' ? principals : [],
          filter,
          ...(via ? { via: { to: via.to, filter: via.filter, ...(via.ended ? { endedAt: via.ended.at } : {}) } } : {}),
          existing: steps.map((p) => ({ to: p.to, ...(p.ended ? { endedAt: p.ended.at } : {}) })),
        });
        if (refusal) throw new Problem(400, 'bad_placement', refusal);
        const note = req.body.note?.trim();
        const placed = await store
          .place({ workspace: record.workspace, record: { kind: record.ref.kind, id: record.ref.id }, from: fromKey, to, toPrincipal: principalOfFloor(to), filter, ...(via ? { via: via.id } : {}), ...(note ? { note } : {}), by: caller.id })
          .catch((err: unknown) => {
            if (err instanceof PlacedError) throw new Problem(409, 'already_placed', err.message);
            throw err;
          });
        const toFloor = floors.get(to)!;
        recorded({ actor: caller.id, action: 'record.published', target: record.ref.id, workspace: record.workspace, detail: { placement: placed.id, kind: record.ref.kind, from: fromKey, to, filter, ...(via ? { via: via.id } : {}) } });
        // Tells the floor once, leaving out whoever published it. A failure doesn't undo it.
        void people
          .audience([placed.toPrincipal])
          .then((ids) => ids.filter((id) => id !== caller.id))
          .then(
            (recipients) =>
              recipients.length
                ? notify({
                recipients,
                workspace: record.workspace,
                kind: 'published',
                title: `${record.ref.name} is on ${toFloor.kind === 'org' ? 'the org’s floor' : toFloor.name}`,
                detail: note ?? `${caller.name} published it up, showing ${filter.map((s) => CONTENT_LIFECYCLE.get(s).name.toLowerCase()).join(' and ')}.`,
                    link: '/below',
                  })
                : undefined,
          )
          .catch((err: Error) => log.error({ err: err.message, placement: placed.id }, 'could not tell the floor'));
        return reply.code(201).send(await viewOf(placed, caller, await floorsOf([fromKey, to], caller), record));
      },
    );

    /** Where it sits on the floor it went to, decided by that floor's leads. No folder puts it back under From below. */
    app.put<{ Params: { id: string }; Body: { folder?: string } }>(
      '/placements/:id/landing',
      { schema: { params: idParams, body: { type: 'object', additionalProperties: false, properties: { folder: ID } } } },
      async (req) => {
        const caller = await callerOf(req);
        const p = await store.placement(req.params.id);
        if (!p || p.ended) throw gone();
        if (!leadsReceiving(caller, p)) throw new Problem(403, 'forbidden', 'Only the leads of the floor it’s on decide where it sits there.', { whoCanChange: 'That floor’s leads.' });
        const folderId = req.body.folder;
        if (folderId) {
          const folder = await store.folder(folderId);
          if (!folder || folder.workspace !== caller.workspace.id) throw new Problem(400, 'bad_landing', 'Choose a place in this floor’s library.');
          const record = await held(p.record.kind, p.record.id);
          if (!record) throw gone();
          if (record.ref.level === 'collection') throw new Problem(400, 'bad_landing', 'A whole collection stays as it is: it can’t go inside another. It stays under From below.');
          const wrong = UNIT_LEVELS.named(await store.levelNames()).refusal(folder.level, record.ref.level);
          if (wrong) throw new Problem(400, 'bad_landing', wrong);
        }
        const landed = (await store.landPlacement(p.id, folderId ?? null))!;
        recorded({ actor: caller.id, action: 'record.landed', target: p.record.id, workspace: caller.workspace.id, detail: { placement: p.id, folder: folderId ?? null } });
        return viewOf(landed, caller, await floorsOf([p.from, p.to], caller));
      },
    );

    /** Takes a step back, and every step that went on up through it. */
    app.post<{ Params: { id: string }; Body: { reason?: string } }>(
      '/placements/:id/withdraw',
      { schema: { params: idParams, body: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string', maxLength: 500 } } } } },
      async (req) => {
        const caller = await callerOf(req);
        const p = await store.placement(req.params.id);
        if (!p || p.ended) throw gone();
        if (!(await mayWithdraw(caller, p, await held(p.record.kind, p.record.id))))
          throw new Problem(403, 'forbidden', 'Only whoever published it, or the leads of the floor it’s on, can take it back.', { whoCanChange: 'Whoever published it.' });
        const all = await store.placementsOf([p.record.id]);
        const floors = await floorsOf(all.map((q) => q.to), caller);
        const withIt = above(all.map((q) => asStep(q, floors)), p.id).map((s) => s.id);
        const reason = req.body?.reason?.trim() || undefined;
        const ended = await store.endPlacements([p.id, ...withIt], caller.id, reason);
        recorded({ actor: caller.id, action: 'record.withdrawn', target: p.record.id, workspace: p.workspace, detail: { placement: p.id, to: p.to, also: withIt, ...(reason ? { reason } : {}) } });
        return { withdrawn: ended.map((e) => wire(floors.get(e.to)!)) };
      },
    );

    /** From below: what reached the caller on this floor, each in one place, and where to put it. */
    app.get('/received', async (req): Promise<ReceivedAnswer> => {
      const caller = await callerOf(req);
      const here = callerFloor(caller);
      const principals = await principalsOf(caller);
      const arrived = (await store.placementsTo(here)).filter((p) => principals.includes(p.toPrincipal));
      const reaching = await covering([...new Set(arrived.map((p) => p.record.id))], principals);
      const floors = await floorsOf([...reaching.flatMap((p) => [p.from, p.to])], caller);
      const out: ReceivedAnswer = { here: [], signposts: [], places: [] };
      for (const p of arrived) {
        const seen = viewFor(reaching.filter((q) => q.record.id === p.record.id).map((q) => asStep(q, floors)))!;
        if (seen.place.to === here) {
          const item = await receivedItem(p, caller, principals, floors);
          if (item) out.here.push(item);
        } else {
          const record = await held(p.record.kind, p.record.id);
          const place = reaching.find((q) => q.id === seen.place.id)!;
          const landed = place.landed ? await store.folder(place.landed) : undefined;
          if (record) out.signposts.push({ placement: place.id, record: record.ref, to: wire(floors.get(place.to)!), ...(landed ? { landed: landed.name } : {}) });
        }
      }
      if (caller.workspace.role === 'lead') {
        const access = await accessOn(caller, caller.workspace.id, principals);
        out.places = [...access.folders.values()]
          .filter((f) => f.state === 'open' && !pathTo(access.folders, f.id).some((a) => a.state !== 'open'))
          .map((f): LandingPlace => ({ id: f.id, label: pathTo(access.folders, f.id).map((a) => a.name).join(' › '), level: f.level }))
          .sort((a, b) => a.label.localeCompare(b.label));
      }
      return out;
    });

    /** Inside a folder published up here: its folders, and its documents at the version the caller sees. */
    app.get<{ Params: { id: string }; Querystring: { folder?: string } }>(
      '/received/:id',
      { schema: { params: idParams, querystring: { type: 'object', additionalProperties: false, properties: { folder: ID } } } },
      async (req) => {
        const caller = await callerOf(req);
        const p = await store.placement(req.params.id);
        const principals = await principalsOf(caller);
        if (!p || p.ended || !principals.includes(p.toPrincipal) || p.record.kind !== 'folder') throw gone();
        const record = await held('folder', p.record.id);
        if (!record) throw gone();
        const folders = await store.folders(record.workspace);
        const byId = new Map(folders.map((f) => [f.id, f]));
        const at = byId.get(req.query.folder ?? record.ref.id);
        const path = at ? pathTo(byId, at.id) : [];
        const top = path.findIndex((f) => f.id === record.ref.id);
        if (!at || top < 0 || at.state === 'archived') throw new Problem(404, 'not_found', 'That isn’t inside what was published here.');
        const reaching = await covering(path.map((f) => f.id), principals);
        const states = CONTENT_LIFECYCLE.tidy([...new Set(reaching.flatMap((q) => q.filter))]);
        const { documents } = await store.documents([at.id], { sort: 'title', limit: 200 });
        const shown = (await Promise.all(documents.map(async (d) => ({ d, v: newestPassing(await store.versions(d.id), states) })))).filter((x): x is { d: DocumentRecord; v: VersionRecord } => Boolean(x.v));
        const names = await store.names(shown.map((x) => x.v.createdBy));
        const floorMap = await floorsOf([p.from, p.to], caller);
        const version = (v: VersionRecord) => ({
          number: v.number,
          filename: v.filename,
          mediaType: v.mediaType,
          size: v.size,
          state: v.state,
          createdBy: v.createdBy,
          ...(names.get(v.createdBy) ? { createdByName: names.get(v.createdBy) } : {}),
          createdAt: v.createdAt,
          ...(v.reader ? { reader: v.reader } : {}),
          thumbnail: v.thumbnail,
        });
        return {
          placement: await viewOf(p, caller, floorMap, record),
          folder: { id: at.id, name: at.name, level: at.level },
          path: path.slice(top).map((f) => ({ id: f.id, name: f.name, level: f.level })),
          folders: folders.filter((f) => f.parent === at.id && f.state !== 'archived').map(({ workspace: _, ...f }) => f),
          documents: shown.map(({ d, v }) => ({ id: d.id, folder: d.folder, title: d.title, tags: d.tags, createdBy: d.createdBy, createdAt: d.createdAt, updatedAt: d.updatedAt, latest: version(v), version: version(v) })),
          states,
        };
      },
    );
  };

  return { routes, signpostFor, reachedVersion, receivedIn, waiting, covering, shownThrough };
};
