// Artifacts' scenarios for AUGUR's run suite (augur-run, im-platform ADR 0050). The suite loads this module
// with `--scenarios ../augur-folio/run/index.ts`; each scenario has a row in augur-run's traceability.md.
// The suite runs it from source on Node's type stripping, so it imports nothing and uses only syntax Node
// can strip. The types below are the parts of augur-run's `src/scenario.ts` these scenarios use.

type Answer<T> = { status: number; ok: boolean; body: T };
type Api = {
  get: <T = unknown>(path: string, opts?: { floor?: string }) => Promise<Answer<T>>;
  post: <T = unknown>(path: string, body?: unknown, opts?: { floor?: string }) => Promise<Answer<T>>;
  put: <T = unknown>(path: string, body?: unknown, opts?: { floor?: string }) => Promise<Answer<T>>;
  delete: <T = unknown>(path: string, opts?: { floor?: string }) => Promise<Answer<T>>;
  download: (path: string, opts?: { floor?: string }) => Promise<Answer<string>>;
  upload: <T = unknown>(path: string, raw: string, type: string, opts?: { floor?: string }) => Promise<Answer<T>>;
};
type Persona = { key: string; id: string; name: string; floors: { key: string; id?: string; name: string }[]; roles: string[] };
type Availability = { ok: true } | { ok: false; why: string; whoCanChange?: string };
type Context = {
  parts: Record<string, { persona: Persona; api: Api }>;
  personas: Persona[];
  as: (persona: Persona) => Api;
  cast: { synthetic: { note: string }; documents?: { floor: string; items?: { title: string; text: string }[] }[] };
  seeded: { documents?: Record<string, { id: string }> };
  check: (label: string, ok: boolean, detail?: { expected?: unknown; actual?: unknown }) => boolean;
  note: (text: string, data?: unknown) => void;
  eventually: <T>(probe: () => Promise<{ ok: boolean; value: T }>, o: { withinMs: number; everyMs?: number }) => Promise<{ ok: boolean; value: T; ms: number }>;
  random: () => number;
  state: Record<string, unknown>;
  dry: boolean;
};
type Scenario = {
  id: string;
  title: string;
  owner: string;
  goals: number[];
  cuj?: number;
  given: string;
  when: string;
  then: string;
  cadence: { kind: 'every'; minutes: number; quietMinutes?: number };
  needs: { as: string; role?: string; habit?: string; floors?: 'own' | 'none'; notSameAs?: string[] }[];
  available?: (ctx: Context) => Promise<Availability>;
  run: (ctx: Context) => Promise<void | Availability>;
};

const FOLIO = '/api/folio/v1';
const WORKSPACES = '/api/identity/v1/me/workspaces';
const INBOX = '/api/events/v1/inbox';

type Floor = { id: string; kind: string; name: string; role?: 'member' | 'lead'; path?: { id: string }[] };
type Version = { number: number; state: string };
type DocumentView = { id: string; title: string; latest: Version; issued?: Version; placed?: { to: { id: string } } };
type DocumentAnswer = { document: DocumentView; versions: Version[]; rights: { level: string; add: boolean; manage: boolean }; reached?: { placement: string; version: number } };
type InboxItem = { id: string; app: string; kind: string; state: string; subject?: { id: string } };

/** The collection the scenarios keep on a floor for what they add. */
const COLLECTION = 'Kept by the run suite';
const enc = encodeURIComponent;

const floorsOf = async (api: Api) => {
  const r = await api.get<{ workspaces: Floor[] }>(WORKSPACES);
  return r.ok ? r.body.workspaces : undefined;
};
const isTeam = (f: Floor) => f.kind !== 'personal' && f.kind !== 'org';

/** The scenarios' collection at the top of a floor's library: found, or made by someone who manages it. */
const collectionOn = async (ctx: Context, api: Api, floor: Floor) => {
  const kept = ctx.state[`collection:${floor.id}`] as string | undefined;
  if (kept) return kept;
  const library = await api.get<{ collections: { id: string; name: string }[] }>(`${FOLIO}/library`, { floor: floor.id });
  let id = library.ok ? library.body.collections.find((c) => c.name === COLLECTION)?.id : undefined;
  if (!id) {
    const made = await api.post<{ id: string }>(`${FOLIO}/folders`, { name: COLLECTION }, { floor: floor.id });
    if (!ctx.check(`a collection is made on ${floor.name}`, made.status === 201, { expected: 201, actual: made.status })) return undefined;
    id = made.body.id;
  }
  ctx.state[`collection:${floor.id}`] = id;
  return id;
};

/** A word no other document has, so the scenario finds its own document and no other. */
const wordOf = (ctx: Context) => `runcheck${Math.floor(ctx.random() * 1e9).toString(36)}`;

/** Adds a Markdown document, marked as synthetic, to a folder. */
const add = (ctx: Context, api: Api, floor: string, folder: string, word: string, title: string, body: string) => {
  const q = new URLSearchParams({ filename: `${word}.md`, title: `${title} (${word})` });
  return api.upload<DocumentView>(`${FOLIO}/folders/${enc(folder)}/documents?${q}`, `# ${title}\n\n${body}\n\n${ctx.cast.synthetic.note}`, 'text/markdown', { floor });
};

type Published = { document: string; word: string; to: string; toName: string; author: string; own: string };

/** Adds a document on the author's own floor and publishes it up, in progress, to a team of theirs. */
const publishUp = async (ctx: Context, author: Persona, api: Api): Promise<Published | undefined> => {
  const floors = await floorsOf(api);
  if (!ctx.check('the author’s floors can be read', !!floors)) return undefined;
  const own = floors!.find((f) => f.kind === 'personal');
  if (!ctx.check('the author has a floor of their own', !!own, { actual: floors!.map((f) => f.kind) })) return undefined;
  const collection = await collectionOn(ctx, api, own!);
  if (!collection) return undefined;
  const word = wordOf(ctx);
  const doc = await add(ctx, api, own!.id, collection, word, 'Published up the floors', 'Shown to a team while it is in progress.');
  if (!ctx.check('the author adds a document on their own floor', doc.status === 201, { expected: 201, actual: doc.status })) return undefined;

  const where = await api.get<{ targets: { to: { id: string; name: string; kind: string }; why?: string }[] }>(`${FOLIO}/placements?kind=document&record=${enc(doc.body.id)}`, { floor: own!.id });
  const target = where.ok ? where.body.targets.find((t) => !t.why && t.to.kind !== 'org') : undefined;
  if (!ctx.check('Artifacts offers a team of theirs to publish it up to', !!target, { actual: where.ok ? where.body.targets : where.status })) return undefined;
  const placed = await api.post(`${FOLIO}/placements`, { record: { kind: 'document', id: doc.body.id }, to: target!.to.id, filter: ['in-progress'] }, { floor: own!.id });
  if (!ctx.check(`the author publishes it up to ${target!.to.name}`, placed.status === 201, { expected: 201, actual: placed.status })) return undefined;
  return { document: doc.body.id, word, to: target!.to.id, toName: target!.to.name, author: author.key, own: own!.id };
};

/**
 * Publishing up the floors is counted in who can read (alpha Goal 30): a document published up from
 * someone's own floor waits under From below on the team it went to, opens there at the one version it
 * shows, and stays out of reach for everyone else.
 */
export const floorPublishing: Scenario = {
  id: 'RUN-15',
  title: 'Artifacts published up a floor are read there, and only there',
  owner: 'folio',
  goals: [30],
  cuj: 6,
  given: 'An editor on a team, a person on the same team, and a person on none of it.',
  when: 'The editor adds a document on their own floor and publishes it up to their team while it is in progress. The others look under From below and open it.',
  then: 'The person on that team sees it under From below and opens only the version it shows; the editor’s own listing points to it there; the person elsewhere can’t open it, and is told why.',
  cadence: { kind: 'every', minutes: 120, quietMinutes: 360 },
  needs: [{ as: 'author', role: 'editor', floors: 'own' }],
  run: async (ctx) => {
    const { persona: author, api } = ctx.parts.author!;
    let kept = ctx.state.published as Published | undefined;
    if (!kept) {
      kept = await publishUp(ctx, author, api);
      if (!kept) return;
      ctx.state.published = kept;
      ctx.note(`${author.name} published “${kept.word}” up to ${kept.toName}.`, kept);
    }

    const mine = await api.get<DocumentAnswer>(`${FOLIO}/documents/${enc(kept.document)}`, { floor: kept.own });
    ctx.check('the author’s own copy points to where it is now', mine.ok && mine.body.document.placed?.to.id === kept.to, { actual: mine.ok ? mine.body.document.placed : mine.status });

    // Who is on that team, and who is on none of it, as identity says.
    let reader: Persona | undefined;
    let outsider: { persona: Persona; floor: string } | undefined;
    for (const p of ctx.personas) {
      if (p.key === kept.author || !p.floors.length || (reader && outsider)) continue;
      const team = (await floorsOf(ctx.as(p)))?.filter(isTeam);
      if (!team?.length) continue;
      const on = team.some((f) => f.id === kept.to);
      if (!reader && on) reader = p;
      else if (!outsider && !team.some((f) => f.id === kept.to || f.path?.some((s) => s.id === kept.to))) outsider = { persona: p, floor: team[0]!.id };
    }

    if (reader) {
      const as = ctx.as(reader);
      const below = await as.get<{ here: { placement: { record: { id: string } } }[] }>(`${FOLIO}/received`, { floor: kept.to });
      ctx.check(`someone on ${kept.toName} sees it under From below`, below.ok && below.body.here.some((i) => i.placement.record.id === kept.document), { actual: below.status });
      const open = await as.get<DocumentAnswer>(`${FOLIO}/documents/${enc(kept.document)}`, { floor: kept.to });
      ctx.check(`someone on ${kept.toName} opens it`, open.ok, { actual: open.status });
      ctx.check('they open only the version published up, to read', open.ok && typeof open.body.reached?.version === 'number' && open.body.versions.length === 1 && open.body.rights.level === 'read', {
        actual: open.ok ? { reached: open.body.reached, versions: open.body.versions.length, rights: open.body.rights } : open.status,
      });
    } else ctx.note(`Nobody else in the cast stands on ${kept.toName}, so nobody can look for it there.`);

    if (outsider) {
      const open = await ctx.as(outsider.persona).get<{ message?: string }>(`${FOLIO}/documents/${enc(kept.document)}`, { floor: outsider.floor });
      ctx.check('someone on another floor can’t open it', open.status === 404, { expected: 404, actual: open.status });
      ctx.check('the refusal says why', typeof open.body?.message === 'string' && open.body.message.length > 0, { actual: open.body });
    } else ctx.note(`Everyone in the cast stands on ${kept.toName}, so nobody can be turned away from it.`);
  },
};

/** The organisation's documents the seed added, from the cast, with their ids. */
const orgGuides = (ctx: Context) =>
  (ctx.cast.documents ?? [])
    .filter((g) => g.floor === 'org')
    .flatMap((g) => (g.items ?? []).map((d) => ({ ...d, id: ctx.seeded.documents?.[`org/${d.title}`]?.id })))
    .filter((d): d is { title: string; text: string; id: string } => !!d.id);

/** The spec's T1: someone new finds the org's guide by a few words of its title, and reads it. */
export const findTheGuide: Scenario = {
  id: 'RUN-27',
  title: 'Anyone finds the organisation’s guide by its title, and reads it',
  owner: 'folio',
  goals: [29],
  cuj: 6,
  given: 'A guide the seed added to the organisation’s library, and any person in the cast.',
  when: 'They search the organisation’s floor for the start of the first words of its title, then open it and its file.',
  then: 'The search answers with it, it opens to read, and its file holds what the guide says.',
  cadence: { kind: 'every', minutes: 180, quietMinutes: 360 },
  needs: [{ as: 'reader' }],
  available: async (ctx) =>
    orgGuides(ctx).length
      ? { ok: true }
      : {
          ok: false,
          why: 'The seed added no documents to the organisation’s library on this deployment, so there is no guide to find.',
          whoCanChange: 'One of the organisation’s leads, by making a collection in its library; then `pnpm seed` again adds them.',
        },
  run: async (ctx) => {
    const { api } = ctx.parts.reader!;
    const guides = orgGuides(ctx);
    const guide = guides[Math.floor(ctx.random() * guides.length)]!;
    const org = (await floorsOf(api))?.find((f) => f.kind === 'org');
    if (!ctx.check('the reader stands on the organisation’s floor', !!org)) return;
    // A person types the start of the first words they remember.
    const words = guide.title.split(/\s+/).filter((w) => w.length > 2).slice(0, 3).map((w) => w.slice(0, Math.max(3, w.length - 2)));
    const found = await api.get<{ results: { id: string }[] }>(`${FOLIO}/search?q=${enc(words.join(' '))}`, { floor: org!.id });
    ctx.check('the search finds the guide', found.ok && found.body.results.some((r) => r.id === guide.id), { expected: guide.id, actual: found.ok ? found.body.results.map((r) => r.id) : found.status });
    const open = await api.get<DocumentAnswer>(`${FOLIO}/documents/${enc(guide.id)}`, { floor: org!.id });
    if (!ctx.check('the guide opens', open.ok, { actual: open.status })) return;
    const shown = open.body.document.issued ?? open.body.document.latest;
    const file = await api.download(`${FOLIO}/documents/${enc(guide.id)}/versions/${shown.number}/file`, { floor: org!.id });
    const first = guide.text.split('\n').find((l) => l.trim()) ?? '';
    ctx.check('its file holds what the guide says', file.ok && file.body.includes(first), { expected: first, actual: file.ok ? file.body.slice(0, 120) : file.status });
  },
};

type Pair = { lead: Persona; floor: Floor };

/** A team the author is on whose lead is someone else in the cast, and that lead. */
const leadOver = async (ctx: Context, author: Persona): Promise<Pair | undefined> => {
  const kept = ctx.state[`lead:${author.key}`] as { lead: string; floor: Floor } | undefined;
  const known = kept && ctx.personas.find((p) => p.key === kept.lead);
  if (known) return { lead: known, floor: kept!.floor };
  const teams = (await floorsOf(ctx.as(author)))?.filter((f) => isTeam(f) && f.role !== 'lead') ?? [];
  if (!teams.length) return undefined;
  for (const p of ctx.personas) {
    if (p.key === author.key) continue;
    const led = (await floorsOf(ctx.as(p)))?.find((f) => f.role === 'lead' && teams.some((t) => t.id === f.id));
    if (led) {
      ctx.state[`lead:${author.key}`] = { lead: p.key, floor: led };
      return { lead: p, floor: led };
    }
  }
  return undefined;
};

/** The spec's T2 and T3: an editor sends a document for review, it waits in the lead's Inbox, and the lead Issues it. */
export const reviewAndIssue: Scenario = {
  id: 'RUN-28',
  title: 'A document sent for review waits in the lead’s Inbox, and the lead Issues it',
  owner: 'folio',
  goals: [14],
  cuj: 6,
  given: 'A team with a lead, and an editor on it who isn’t its lead.',
  when: 'The editor adds a document to the team’s library and sends it for review. The lead finds it in their Inbox and Issues it.',
  then: 'The review waits in the lead’s Inbox; once Issued, the document reads Issued to its team, and the review is no longer open.',
  cadence: { kind: 'every', minutes: 240, quietMinutes: 480 },
  needs: [{ as: 'author', role: 'editor', floors: 'own' }],
  available: async (ctx) =>
    (await leadOver(ctx, ctx.parts.author!.persona))
      ? { ok: true }
      : {
          ok: false,
          why: `No team ${ctx.parts.author!.persona.key} is on has a lead in the cast, so nobody reviews what they send.`,
          whoCanChange: 'An admin, by making someone a team’s lead in Admin.',
        },
  run: async (ctx) => {
    const { persona: writer, api: author } = ctx.parts.author!;
    const pair = (await leadOver(ctx, writer))!;
    const { floor } = pair;
    const lead = ctx.as(pair.lead);
    const collection = await collectionOn(ctx, lead, floor);
    if (!collection) return;
    const word = wordOf(ctx);
    const doc = await add(ctx, author, floor.id, collection, word, 'Sent for review', `Added to ${floor.name}’s library and sent for its lead to review.`);
    if (!ctx.check(`${writer.name} adds a document to ${floor.name}’s library`, doc.status === 201, { expected: 201, actual: doc.status })) return;
    const sent = await author.post(`${FOLIO}/documents/${enc(doc.body.id)}/versions/1/state`, { to: 'in-review' }, { floor: floor.id });
    if (!ctx.check('they send it for review', sent.ok, { actual: sent.status })) return;

    const waiting = await ctx.eventually(
      async () => {
        const r = await lead.get<InboxItem[]>(`${INBOX}?tab=teams&limit=100`);
        const mine = await lead.get<InboxItem[]>(`${INBOX}?tab=you&limit=100`);
        const item = [...(r.ok && Array.isArray(r.body) ? r.body : []), ...(mine.ok && Array.isArray(mine.body) ? mine.body : [])].find((i) => i.subject?.id === doc.body.id);
        return { ok: !!item && item.state === 'open', value: item };
      },
      { withinMs: ctx.dry ? 10_000 : 60_000, everyMs: 5_000 },
    );
    ctx.check(`the review waits in ${pair.lead.name}’s Inbox`, waiting.ok, { actual: waiting.value });

    const issued = await lead.post(`${FOLIO}/documents/${enc(doc.body.id)}/versions/1/state`, { to: 'issued' }, { floor: floor.id });
    if (!ctx.check(`${pair.lead.name} Issues it`, issued.ok, { actual: issued.status })) return;
    const read = await author.get<DocumentAnswer>(`${FOLIO}/documents/${enc(doc.body.id)}`, { floor: floor.id });
    ctx.check('it reads Issued to its team', read.ok && read.body.document.issued?.number === 1, { actual: read.ok ? read.body.document.issued : read.status });
    if (waiting.value) {
      const after = await lead.get<InboxItem>(`${INBOX}/${enc(waiting.value.id)}`);
      ctx.check('the review is no longer open', after.ok && after.body.state !== 'open', { actual: after.ok ? after.body.state : after.status });
    }
  },
};

/** A document of the persona's own, on their own floor, made once and kept. */
const ownDocument = async (ctx: Context, owner: Persona, api: Api, key: string, title: string, body: string) => {
  const kept = ctx.state[key] as { document: string; floor: string; word: string } | undefined;
  if (kept) return kept;
  const own = (await floorsOf(api))?.find((f) => f.kind === 'personal');
  if (!ctx.check(`${owner.name} has a floor of their own`, !!own)) return undefined;
  const collection = await collectionOn(ctx, api, own!);
  if (!collection) return undefined;
  const word = wordOf(ctx);
  const doc = await add(ctx, api, own!.id, collection, word, title, body);
  if (!ctx.check(`${owner.name} adds a document on their own floor`, doc.status === 201, { expected: 201, actual: doc.status })) return undefined;
  const made = { document: doc.body.id, floor: own!.id, word };
  ctx.state[key] = made;
  return made;
};

/** The spec's T6: a document is shared sideways with one person, to read; nothing else of its floor opens to them. */
export const shareSideways: Scenario = {
  id: 'RUN-29',
  title: 'A document shared with one person opens to them to read, and closes again',
  owner: 'folio',
  goals: [29, 30],
  cuj: 6,
  given: 'A person with a document on their own floor, and someone else on another floor.',
  when: 'The owner shares it with them to read; they open it and try to add a version; the owner takes the share back.',
  then: 'It is listed as shared with them and opens to read only; adding a version is refused; once taken back it no longer opens.',
  cadence: { kind: 'every', minutes: 180, quietMinutes: 360 },
  needs: [{ as: 'owner', habit: 'writes' }, { as: 'other', notSameAs: ['owner'] }],
  run: async (ctx) => {
    const { persona: owner, api } = ctx.parts.owner!;
    const { persona: other, api: them } = ctx.parts.other!;
    const kept = await ownDocument(ctx, owner, api, 'shared', 'Shared sideways', 'Shared with one person, to read.');
    if (!kept) return;
    const theirs = (await floorsOf(them))?.[0];
    if (!ctx.check(`${other.name} stands on a floor`, !!theirs)) return;
    const path = `${FOLIO}/documents/${enc(kept.document)}`;
    const principal = `person:${other.id}`;
    const grant = { kind: 'document', record: kept.document, principal };

    const before = await them.get(path, { floor: theirs!.id });
    ctx.check('before it is shared, it doesn’t open to them', before.status === 404, { expected: 404, actual: before.status });
    const shared = await api.put(`${FOLIO}/grants`, { ...grant, level: 'read' }, { floor: kept.floor });
    if (!ctx.check(`${owner.name} shares it with ${other.name} to read`, shared.ok, { actual: shared.status })) return;
    try {
      const listed = await them.get<{ items: { id: string; level: string }[] }>(`${FOLIO}/shared`, { floor: theirs!.id });
      ctx.check('it is listed as shared with them', listed.ok && listed.body.items.some((i) => i.id === kept.document && i.level === 'read'), { actual: listed.status });
      const open = await them.get<DocumentAnswer>(path, { floor: theirs!.id });
      ctx.check('it opens to them, to read only', open.ok && open.body.rights.level === 'read' && !open.body.rights.add, { actual: open.ok ? open.body.rights : open.status });
      const q = new URLSearchParams({ filename: `${kept.word}.md` });
      const theirVersion = await them.upload(`${path}/versions?${q}`, `# Not theirs to change\n\n${ctx.cast.synthetic.note}`, 'text/markdown', { floor: theirs!.id });
      ctx.check('adding a version is refused', theirVersion.status === 403, { expected: 403, actual: theirVersion.status });
    } finally {
      const back = await api.delete(`${FOLIO}/grants?${new URLSearchParams({ kind: 'document', record: kept.document, principal })}`, { floor: kept.floor });
      ctx.check('the owner takes the share back', back.status === 204, { expected: 204, actual: back.status });
    }
    const after = await them.get(path, { floor: theirs!.id });
    ctx.check('once taken back, it no longer opens to them', after.status === 404, { expected: 404, actual: after.status });
  },
};

/** The spec's T7: a new version in progress doesn't take the Issued one away from readers. */
export const versionTwo: Scenario = {
  id: 'RUN-30',
  title: 'Version 2 in progress doesn’t take Issued version 1 away',
  owner: 'folio',
  goals: [29],
  cuj: 6,
  given: 'A person with a document on their own floor, which they lead.',
  when: 'They Issue version 1, then add version 2 and leave it in progress.',
  then: 'The document keeps version 1 as its Issued one, version 2 is listed in progress, and version 1’s file is still what it was.',
  cadence: { kind: 'every', minutes: 240, quietMinutes: 480 },
  needs: [{ as: 'owner', habit: 'writes' }],
  run: async (ctx) => {
    const { persona: owner, api } = ctx.parts.owner!;
    const first = 'Version one, as Issued.';
    const kept = await ownDocument(ctx, owner, api, 'versioned', 'Two versions', first);
    if (!kept) return;
    const path = `${FOLIO}/documents/${enc(kept.document)}`;
    const now = await api.get<DocumentAnswer>(path, { floor: kept.floor });
    if (!ctx.check(`${owner.name} opens their document`, now.ok, { actual: now.status })) return;
    if (!now.body.document.issued) {
      const issued = await api.post(`${path}/versions/1/state`, { to: 'issued' }, { floor: kept.floor });
      if (!ctx.check('they Issue version 1', issued.ok, { actual: issued.status })) return;
    }
    if (now.body.document.latest.number < 2) {
      const q = new URLSearchParams({ filename: `${kept.word}.md` });
      const second = await api.upload(`${path}/versions?${q}`, `# Two versions\n\nVersion two, in progress.\n\n${ctx.cast.synthetic.note}`, 'text/markdown', { floor: kept.floor });
      if (!ctx.check('they add version 2', second.status === 201, { expected: 201, actual: second.status })) return;
    }
    const after = await api.get<DocumentAnswer>(path, { floor: kept.floor });
    if (!ctx.check('the document opens', after.ok, { actual: after.status })) return;
    ctx.check('version 1 is still its Issued one', after.body.document.issued?.number === 1, { actual: after.body.document.issued });
    ctx.check('version 2 is listed in progress', after.body.versions.some((v) => v.number === 2 && v.state === 'in-progress'), { actual: after.body.versions });
    const file = await api.download(`${path}/versions/1/file`, { floor: kept.floor });
    ctx.check('version 1’s file is still what it was', file.ok && file.body.includes(first), { expected: first, actual: file.ok ? file.body.slice(0, 120) : file.status });
  },
};

export const scenarios = [floorPublishing, findTheGuide, reviewAndIssue, shareSideways, versionTwo];
