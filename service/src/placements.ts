import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { above, chainOf, CONTENT_LIFECYCLE, floorRank, floorsAbove, furthest, levelFrom, newestPassing, ownerOf, placementRefusal, reaches, viewFor, within, type ContentState, type Floor, type Placement as Step } from '@augur/records';
import type { AudienceLookup, DirectorySearch } from '@augur/service-kit';
import type { Audit } from './audit.ts';
import { rightsOn, type HeldLibrary, type OnFloor } from './app.ts';
import type { Notify } from './notices.ts';
import { describePrincipals, type CallerPrincipals } from './people.ts';
import { PUBLISHER_ROLE } from './publishing.ts';
import { BadParentError, PlacedError, type Folder, type FolioDocument, type FolioStore, type Library, type Placement, type RecordRefIn } from './store.ts';
import { UNIT_LEVELS, type UnitLevel } from './units.ts';

export interface PlacementDeps {
  store: FolioStore;
  audit: Audit;
  onFloor(req: FastifyRequest, reply: FastifyReply): OnFloor | undefined;
  reach(caller: OnFloor, id: string): Promise<HeldLibrary | undefined>;
  principalsOf: CallerPrincipals;
  directory: DirectorySearch;
  audience: AudienceLookup;
  notify: Notify;
  log: { error(obj: object, msg: string): void };
}

/** The floor a library is on, as placements name floors: a team's or someone's own floor's id, or `org`. */
export const floorKeyOf = (library: Pick<Library, 'floor' | 'workspace'>) => (library.floor === 'org' ? 'org' : library.workspace);
/** The floor the caller is standing on, named the same way. */
export const callerFloor = (caller: OnFloor) => (caller.workspace.kind === 'org' ? 'org' : caller.workspace.id);
/** Who a floor lets in, to see what's put on it. */
export const principalOfFloor = (floor: string) => (floor === 'org' ? 'org' : `tree:${floor}`);

/** A floor as people see it: its name, and how high it sits. */
export interface FloorView {
  id: string;
  kind: Floor['kind'];
  name: string;
  rank: number;
  path: string[];
}

/** What a record is, as a placement shows it. */
export interface RecordView {
  kind: RecordRefIn['kind'];
  id: string;
  level: UnitLevel;
  name: string;
  library: string;
  libraryName: string;
}

const ID = { type: 'string', maxLength: 64 } as const;
const FILTER = { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', enum: CONTENT_LIFECYCLE.states.map((s) => s.id) } } as const;
const LANDING = { type: 'object', additionalProperties: false, required: ['library'], properties: { library: ID, folder: ID } } as const;
const RECORD = { type: 'object', additionalProperties: false, required: ['kind', 'id'], properties: { kind: { type: 'string', enum: ['library', 'folder', 'document'] }, id: ID } } as const;
const PARAMS = { type: 'object', properties: { id: ID }, required: ['id'] } as const;

/**
 * Where floors sit, from the directory (a team's path) and the caller's own
 * floor (which the directory doesn't list under `pnpm dev:app`).
 */
export const floorsFrom = (directory: DirectorySearch) => async (keys: readonly string[], caller?: OnFloor): Promise<Map<string, FloorView>> => {
  const teams = [...new Set(keys.filter((k) => k !== 'org'))];
  const found = teams.length ? (await directory({ ids: teams })).teams : [];
  const named = new Map(found.map((t) => [t.id, t]));
  const out = new Map<string, FloorView>();
  for (const key of new Set(keys)) {
    if (key === 'org') out.set(key, { id: key, kind: 'org', name: 'The org', rank: 0, path: [] });
    else if (named.has(key)) {
      const team = named.get(key)!;
      const path = team.path?.length ? team.path : [key];
      out.set(key, { id: key, kind: 'team', name: team.name, rank: floorRank({ kind: 'team', path }), path });
    } else if (caller && caller.workspace.id === key && caller.workspace.kind === 'personal') out.set(key, { id: key, kind: 'personal', name: 'Your own floor', rank: floorRank({ kind: 'personal', path: [] }), path: [] });
    else if (caller && caller.workspace.id === key && caller.workspace.kind === 'team') out.set(key, { id: key, kind: 'team', name: 'This team', rank: 1, path: [key] });
    else out.set(key, { id: key, kind: 'personal', name: 'Someone’s own floor', rank: floorRank({ kind: 'personal', path: [] }), path: [] });
  }
  return out;
};

/**
 * Publishing up the floors (docs/app-patterns.md, `@augur/records`): a record
 * (a whole collection, a folder in one, or a document) put on a floor above
 * its own through a filter of lifecycle states, as a live window. The floor
 * that received it may publish it further up, never showing more. One owner:
 * the highest floor it has reached. Each person sees it in one place only, the
 * highest floor that shows it to them; the floors below say where it went.
 */

export const placementRoutes = async (app: FastifyInstance, { store, audit, onFloor, reach, principalsOf, directory, audience, notify, log }: PlacementDeps) => {
  const describe = describePrincipals(directory);
  const recorded = (entry: Parameters<Audit>[0]) =>
    audit(entry).catch((err: Error) => log.error({ err: err.message, action: entry.action, target: entry.target }, 'could not record in the audit log'));

  const floorsOf = floorsFrom(directory);

  /** A step as `@augur/records` reasons about it: with how high its floor sits. */
  const asStep = (p: Placement, floors: Map<string, FloorView>): Step<ContentState> => ({
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

  /** The record a reference names, in its library, with its level and name; undefined when it isn't there. */
  const recordIn = async (library: Library, ref: RecordRefIn): Promise<(RecordView & { folder?: Folder; document?: FolioDocument }) | undefined> => {
    const base = { kind: ref.kind, id: ref.id, library: library.id, libraryName: library.name };
    if (ref.kind === 'library') return ref.id === library.id ? { ...base, level: 'collection', name: library.name } : undefined;
    if (ref.kind === 'folder') {
      const folder = (await store.folders(library.id)).find((f) => f.id === ref.id);
      return folder && { ...base, level: folder.level, name: folder.name, folder };
    }
    const document = await store.document(ref.id);
    return document?.library === library.id ? { ...base, level: 'file', name: document.title, document } : undefined;
  };

  const sendRefusal = (reply: FastifyReply, code: number, error: string, message: string) => reply.code(code).send({ error, message });

  /** A placement as it's sent: its floors named, its record, and its chain and owner. */
  const view = async (p: Placement, caller: OnFloor) => {
    const all = await store.placementsOf(p.record.id);
    const library = await store.library(p.library, { archived: true });
    const floors = await floorsOf([...all.flatMap((q) => [q.from, q.to]), ...(library ? [floorKeyOf(library)] : [])], caller);
    const steps = all.map((q) => asStep(q, floors));
    const own = library ? floorKeyOf(library) : p.from;
    const record = library && (await recordIn(library, p.record));
    return {
      ...p,
      record: record ? { kind: record.kind, id: record.id, level: record.level, name: record.name, library: record.library, libraryName: record.libraryName } : { ...p.record },
      fromFloor: floors.get(p.from),
      toFloor: floors.get(p.to),
      owner: floors.get(ownerOf(own, steps)),
      chain: chainOf(steps, p.id).map((s) => ({ id: s.id, from: floors.get(s.from), to: floors.get(s.to), filter: s.filter, by: s.by, at: s.at })),
    };
  };

  /** Whether the caller manages a record on its own floor: its library's managers, or, for a document, a grant on it. */
  const manages = async (caller: OnFloor, library: HeldLibrary, record: RecordRefIn) => {
    if (rightsOn(caller, library).manage) return true;
    if (record.kind !== 'document') return false;
    return reaches(furthest(library.level, levelFrom(await store.grantsOn(record.id), await principalsOf(caller))), 'manage');
  };

  /** Who may change a step's filter, or take it back: whoever published it, from the floor it came from. */
  const mayManage = async (caller: OnFloor, p: Placement) => {
    if (p.via) return callerFloor(caller) === p.from && caller.workspace.role === 'lead';
    const library = await reach(caller, p.library);
    return Boolean(library?.level) && manages(caller, library!, p.record);
  };

  /** Whether the caller leads the floor a step went to: they decide where it sits there, and may send it back. */
  const leadsReceiving = (caller: OnFloor, p: Placement) => callerFloor(caller) === p.to && caller.workspace.role === 'lead';

  /** Checks a landing place on the receiving floor: one of its libraries, where the record's level fits. */
  const landingRefusal = async (to: string, level: UnitLevel, landing: { library: string; folder?: string }) => {
    const target = await store.library(landing.library);
    if (!target || floorKeyOf(target) !== to) return 'Choose a place on the floor it’s going to.';
    if (level === 'collection') return 'A whole collection sits on the floor as it is: it can’t go inside another.';
    const folder = landing.folder ? (await store.folders(target.id)).find((f) => f.id === landing.folder) : undefined;
    if (landing.folder && !folder) return 'That place isn’t in that collection.';
    const levels = UNIT_LEVELS.named(await store.levelNames());
    return levels.refusal(folder?.level ?? 'collection', level);
  };

  /** Tells the floor something arrived, once, leaving out whoever published it. A failure doesn't undo it. */
  const tell = async (caller: OnFloor, p: Placement, name: string, floorName: string) => {
    try {
      const recipients = (await audience([p.toPrincipal])).filter((id) => id !== caller.id);
      if (!recipients.length) return;
      await notify({
        recipients,
        workspace: p.workspace,
        title: `${name} is on ${floorName === 'The org' ? 'the org’s floor' : floorName}`,
        detail: p.note ?? `${caller.name} published it, showing ${p.filter.map((s) => CONTENT_LIFECYCLE.get(s).name.toLowerCase()).join(', ')}.`,
        link: `/received/${p.id}`,
        actions: [{ label: 'Open', intent: { type: 'folio.open', payload: { path: `/received/${p.id}` } } }],
      });
    } catch (err) {
      log.error({ err: (err as Error).message, placement: p.id }, 'could not tell the floor');
    }
  };

  app.post<{ Body: { library: string; record: RecordRefIn; to: string; filter: ContentState[]; via?: string; landing?: { library: string; folder?: string }; note?: string } }>(
    '/placements',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['library', 'record', 'to', 'filter'],
          properties: { library: ID, record: RECORD, to: ID, filter: FILTER, via: ID, landing: LANDING, note: { type: 'string', maxLength: 500 } },
        },
      },
    },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const { to, via: viaId, landing } = req.body;
      const filter = CONTENT_LIFECYCLE.tidy(req.body.filter);
      const notFound = () => sendRefusal(reply, 404, 'not-found', 'There’s no such thing to publish, or it hasn’t been shared with you.');
      const via = viaId ? await store.placement(viaId) : undefined;
      if (viaId && (!via || via.record.id !== req.body.record.id || via.library !== req.body.library)) return notFound();

      // From its own floor, by whoever manages it; or on up from a floor that received it, by that floor's leads.
      const library = await store.library(req.body.library);
      if (!library) return notFound();
      const record = await recordIn(library, req.body.record);
      if (!record) return notFound();
      if (via) {
        if (callerFloor(caller) !== via.to || caller.workspace.role !== 'lead') return sendRefusal(reply, 403, 'forbidden', 'Only the leads of the floor that received it can publish it further up, from that floor.');
      } else {
        const held = await reach(caller, library.id);
        if (!held?.level) return notFound();
        if (!(await manages(caller, held, record))) return sendRefusal(reply, 403, 'forbidden', 'Only whoever manages it can publish it.');
      }
      if (to === 'org' && !caller.roles.includes(PUBLISHER_ROLE)) return sendRefusal(reply, 403, 'publisher-only', 'Publishing to the org needs the publisher role, which an admin can give you.');

      const fromKey = via ? via.to : floorKeyOf(library);
      const floors = await floorsOf([fromKey, to], caller);
      const from = floors.get(fromKey)!;
      const refusal = placementRefusal({
        from: { id: from.id, kind: from.kind, path: from.path },
        to,
        principals: from.kind === 'personal' ? await principalsOf(caller) : [],
        filter,
        via: via && { to: via.to, filter: via.filter, ...(via.ended ? { endedAt: via.ended.at } : {}) },
        existing: (await store.placementsOf(record.id)).map((p) => ({ to: p.to, ...(p.ended ? { endedAt: p.ended.at } : {}) })),
      });
      if (refusal) return sendRefusal(reply, 400, 'bad-placement', refusal);
      if (landing) {
        const wrong = await landingRefusal(to, record.level, landing);
        if (wrong) return sendRefusal(reply, 400, 'bad-landing', wrong);
      }
      try {
        const placed = await store.place({
          library: library.id,
          record: { kind: record.kind, id: record.id },
          from: fromKey,
          to,
          toPrincipal: principalOfFloor(to),
          filter,
          ...(via ? { via: via.id } : {}),
          ...(landing ? { landed: landing } : {}),
          ...(req.body.note?.trim() ? { note: req.body.note.trim() } : {}),
          by: caller.id,
        });
        const toName = floors.get(to)?.name ?? to;
        await recorded({
          actor: caller.id,
          action: 'record.published',
          target: record.id,
          workspace: library.workspace,
          detail: { placement: placed.id, kind: record.kind, name: record.name, library: library.id, from: fromKey, to, filter, ...(via ? { via: via.id } : {}) },
        });
        await tell(caller, placed, record.name, toName);
        return reply.code(201).send(await view(placed, caller));
      } catch (err) {
        if (err instanceof PlacedError) return sendRefusal(reply, 409, 'already-placed', err.message);
        if (err instanceof BadParentError) return notFound();
        throw err;
      }
    },
  );

  /** Every step a record has been published by, with its chain and owner: for whoever can see it. */
  /**
   * Where the caller could publish a record next: up from its own floor, when
   * they manage it there, or on up from a floor that received it, when they lead
   * that floor. Each floor above is listed, with why when it can't be chosen.
   */
  const targetsFor = async (caller: OnFloor, library: HeldLibrary | undefined, recordId: string, steps: readonly Placement[]) => {
    const live = steps.filter((p) => !p.ended);
    const starts: { from: string; via?: Placement }[] = [];
    if (library?.level) {
      const ref = steps[0]?.record ?? (await refOf(library, recordId));
      if (ref && (await manages(caller, library, ref))) starts.push({ from: floorKeyOf(library) });
    }
    for (const p of live) if (leadsReceiving(caller, p)) starts.push({ from: p.to, via: p });
    if (!starts.length) return [];
    const principals = await principalsOf(caller);
    const fromFloors = await floorsOf(starts.map((s) => s.from), caller);
    const options = starts.flatMap(({ from, via }) => {
      const at = fromFloors.get(from)!;
      return floorsAbove({ id: at.id, kind: at.kind, path: at.path }, at.kind === 'personal' ? principals : []).map((to) => ({ from, to, via }));
    });
    const names = await floorsOf(options.map((o) => o.to), caller);
    return options.map(({ from, to, via }) => {
      const why = live.some((p) => p.to === to)
        ? 'It’s already there.'
        : to === 'org' && !caller.roles.includes(PUBLISHER_ROLE)
          ? 'Publishing to the org needs the publisher role, which an admin can give you.'
          : undefined;
      return { from: fromFloors.get(from), to: names.get(to), ...(via ? { via: via.id, most: via.filter } : {}), ...(why ? { why } : {}) };
    });
  };

  /** A record of the library by its id alone: the library itself, one of its folders, or one of its documents. */
  const refOf = async (library: Library, id: string): Promise<RecordRefIn | undefined> => {
    if (id === library.id) return { kind: 'library', id };
    if ((await store.folders(library.id)).some((f) => f.id === id)) return { kind: 'folder', id };
    const doc = await store.document(id);
    return doc && doc.library === library.id ? { kind: 'document', id } : undefined;
  };

  app.get<{ Querystring: { library: string; record: string } }>(
    '/placements',
    { schema: { querystring: { type: 'object', additionalProperties: false, required: ['library', 'record'], properties: { library: ID, record: ID } } } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const steps = (await store.placementsOf(req.query.record)).filter((p) => p.library === req.query.library);
      const library = await reach(caller, req.query.library);
      const principals = await principalsOf(caller);
      const sees = Boolean(library?.level) || steps.some((p) => !p.ended && principals.includes(p.toPrincipal));
      if (!sees) return sendRefusal(reply, 404, 'not-found', 'There’s no such thing, or it hasn’t been shared with you.');
      const views = await Promise.all(steps.map((p) => view(p, caller)));
      const live = views.filter((v) => !v.ended);
      return {
        targets: await targetsFor(caller, library, req.query.record, steps),
        placements: await Promise.all(
          views.map(async (v) => ({ ...v, can: { change: !v.ended && (await mayManage(caller, steps.find((s) => s.id === v.id)!)), land: !v.ended && leadsReceiving(caller, steps.find((s) => s.id === v.id)!) } })),
        ),
        owner: live[0]?.owner ?? (library ? (await floorsOf([floorKeyOf(library)], caller)).get(floorKeyOf(library)) : undefined),
      };
    },
  );

  /** Changes what a step shows: whoever published it. Steps above it never show more. */
  app.patch<{ Params: { id: string }; Body: { filter: ContentState[] } }>(
    '/placements/:id',
    { schema: { params: PARAMS, body: { type: 'object', additionalProperties: false, required: ['filter'], properties: { filter: FILTER } } } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const p = await store.placement(req.params.id);
      if (!p || p.ended) return sendRefusal(reply, 404, 'not-found', 'It isn’t on that floor any more.');
      if (!(await mayManage(caller, p))) return sendRefusal(reply, 403, 'forbidden', 'Only whoever published it can change what it shows.');
      const filter = CONTENT_LIFECYCLE.tidy(req.body.filter);
      const via = p.via ? await store.placement(p.via) : undefined;
      if (via && filter.some((s) => !via.filter.includes(s))) return sendRefusal(reply, 400, 'bad-placement', 'A floor can’t show more than it was shown: choose from the states it received.');
      const changed = await store.setPlacementFilter(p.id, filter, caller.id);
      await recorded({ actor: caller.id, action: 'record.publication-changed', target: p.record.id, workspace: p.workspace, detail: { placement: p.id, to: p.to, filter, was: p.filter } });
      return view(changed!, caller);
    },
  );

  /** Where it sits on the floor it went to: that floor's leads, or whoever published it. Nowhere is "From below". */
  const land = async (req: FastifyRequest<{ Params: { id: string }; Body?: { library: string; folder?: string } }>, reply: FastifyReply) => {
    const caller = onFloor(req, reply);
    if (!caller) return reply;
    const p = await store.placement(req.params.id);
    if (!p || p.ended) return sendRefusal(reply, 404, 'not-found', 'It isn’t on that floor any more.');
    if (!leadsReceiving(caller, p) && !(await mayManage(caller, p))) return sendRefusal(reply, 403, 'forbidden', 'Only the leads of the floor it’s on, or whoever published it, can move it there.');
    if (req.body) {
      const library = await store.library(p.library, { archived: true });
      const record = library && (await recordIn(library, p.record));
      const wrong = record ? await landingRefusal(p.to, record.level, req.body) : 'It isn’t there any more.';
      if (wrong) return sendRefusal(reply, 400, 'bad-landing', wrong);
    }
    return view((await store.landPlacement(p.id, req.body ?? null))!, caller);
  };
  app.put<{ Params: { id: string }; Body: { library: string; folder?: string } }>('/placements/:id/landing', { schema: { params: PARAMS, body: LANDING } }, land);
  app.delete<{ Params: { id: string } }>('/placements/:id/landing', { schema: { params: PARAMS } }, land);

  /** Takes a step back, and every step that went on up from it: whoever published it, or the leads of the floor it's on. */
  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    '/placements/:id/withdraw',
    { schema: { params: PARAMS, body: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string', maxLength: 500 } } } } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const p = await store.placement(req.params.id);
      if (!p || p.ended) return sendRefusal(reply, 404, 'not-found', 'It isn’t on that floor any more.');
      if (!leadsReceiving(caller, p) && !(await mayManage(caller, p))) return sendRefusal(reply, 403, 'forbidden', 'Only whoever published it, or the leads of the floor it’s on, can take it back.');
      const all = await store.placementsOf(p.record.id);
      const floors = await floorsOf(all.map((q) => q.to), caller);
      const withIt = above(all.map((q) => asStep(q, floors)), p.id).map((s) => s.id);
      const reason = req.body?.reason?.trim() || undefined;
      const ended = await store.endPlacements([p.id, ...withIt], caller.id, reason);
      await recorded({ actor: caller.id, action: 'record.withdrawn', target: p.record.id, workspace: p.workspace, detail: { placement: p.id, from: p.from, to: p.to, also: withIt, ...(reason ? { reason } : {}) } });
      return { withdrawn: ended.map((e) => ({ id: e.id, to: floors.get(e.to) })) };
    },
  );

  /** What would go with a step if it were taken back: the floors to warn about first. */
  app.get<{ Params: { id: string } }>('/placements/:id/above', { schema: { params: PARAMS } }, async (req, reply) => {
    const caller = onFloor(req, reply);
    if (!caller) return reply;
    const p = await store.placement(req.params.id);
    if (!p || p.ended) return sendRefusal(reply, 404, 'not-found', 'It isn’t on that floor any more.');
    const all = await store.placementsOf(p.record.id);
    const floors = await floorsOf(all.map((q) => q.to), caller);
    return { above: above(all.map((q) => asStep(q, floors)), p.id).map((s) => floors.get(s.to)) };
  });

  /**
   * What the caller reaches through placements, as one floor shows it. Each
   * record is shown here only when this is the highest floor that shows it to
   * them; otherwise it's a signpost to where it is. `states` says, for each
   * state they may see, which floor shows it them.
   */
  const reachedOn = async (caller: OnFloor) => {
    const here = callerFloor(caller);
    const principals = await principalsOf(caller);
    const landed = (await store.placementsOn(here)).filter((p) => principals.includes(p.toPrincipal));
    const records = [...new Map(landed.map((p) => [p.record.id, p])).values()];
    const out: { here: Awaited<ReturnType<typeof view>>[]; signposts: { placement: string; record: RecordView | RecordRefIn; to?: FloorView; reached: string }[] } = { here: [], signposts: [] };
    for (const p of records) {
      const all = (await store.placementsOf(p.record.id)).filter((q) => !q.ended && principals.includes(q.toPrincipal));
      const floors = await floorsOf(all.map((q) => q.to), caller);
      const seen = viewFor(all.map((q) => asStep(q, floors)))!;
      const shown = await view(p, caller);
      if (seen.place.to === here) {
        out.here.push({ ...shown, states: Object.fromEntries([...seen.states].map(([state, step]) => [state, floors.get(step.to)])) } as typeof shown);
      } else out.signposts.push({ placement: seen.place.id, record: shown.record, to: floors.get(seen.place.to), reached: p.id });
    }
    return out;
  };

  app.get('/received', async (req, reply) => {
    const caller = onFloor(req, reply);
    if (!caller) return reply;
    return reachedOn(caller);
  });

  /**
   * Inside something that reached the caller here: its folders, and the
   * documents in `folder` (or at its top), each with the version the caller
   * sees (the newest any of their floors lets through) and, when only a floor
   * below this one shows that version, which floor.
   */
  app.get<{ Params: { id: string }; Querystring: { folder?: string } }>(
    '/received/:id',
    { schema: { params: PARAMS, querystring: { type: 'object', additionalProperties: false, properties: { folder: ID } } } },
    async (req, reply) => {
      const caller = onFloor(req, reply);
      if (!caller) return reply;
      const p = await store.placement(req.params.id);
      const principals = await principalsOf(caller);
      if (!p || p.ended || !principals.includes(p.toPrincipal)) return sendRefusal(reply, 404, 'not-found', 'It isn’t on this floor, or not for you.');
      const reaching = (await store.placementsOf(p.record.id)).filter((q) => !q.ended && principals.includes(q.toPrincipal));
      const floors = await floorsOf(reaching.map((q) => q.to), caller);
      const seen = viewFor(reaching.map((q) => asStep(q, floors)))!;
      const library = (await store.library(p.library, { archived: true }))!;
      const record = (await recordIn(library, p.record))!;
      const folders = await store.folders(library.id);
      // Only what's inside the record.
      const inside = record.kind === 'library' ? folders : record.kind === 'folder' ? folders.filter((f) => f.id !== record.id && within(folders, record.id).has(f.id)) : [];
      const at = req.query.folder ?? (record.kind === 'folder' ? record.id : undefined);
      if (req.query.folder && !inside.some((f) => f.id === req.query.folder)) return sendRefusal(reply, 404, 'not-found', 'That isn’t inside it.');
      const docs = record.kind === 'document' ? [record.document!] : (await store.documents(library.id, { folder: at, sort: 'title' })).documents;
      const states = [...seen.states.keys()];
      const own = new Set(p.filter);
      const documents = (
        await Promise.all(
          docs.map(async (d) => {
            const shown = newestPassing(await store.versions(d.id), states);
            if (!shown) return undefined;
            const via = own.has(shown.state) ? undefined : floors.get(seen.states.get(shown.state)!.to);
            return { ...d, latest: shown, ...(via ? { onlyVia: via } : {}) };
          }),
        )
      ).filter(Boolean);
      return { placement: await view(p, caller), folders: inside, folder: at ?? null, documents, states: Object.fromEntries([...seen.states].map(([s, step]) => [s, floors.get(step.to)])) };
    },
  );
};

/**
 * How far a placement lets someone into a document they can't otherwise read:
 * to the newest version any of their floors' steps lets through, and no other.
 */
export const reachedVersion = async (store: FolioStore, document: string, principals: readonly string[]) => {
  const steps = (await store.covering(document)).filter((p) => principals.includes(p.toPrincipal));
  if (!steps.length) return undefined;
  const states = new Set(steps.flatMap((p) => p.filter));
  return newestPassing(await store.versions(document), states)?.number;
};
