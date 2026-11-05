// Artifacts' scenarios for AUGUR's run suite (augur-run, im-platform ADR 0050). The suite loads this module
// with `--scenarios ../augur-folio/run/index.ts`; each scenario has a row in augur-run's traceability.md.
// The suite runs it from source on Node's type stripping, so it imports nothing and uses only syntax Node
// can strip. The types below are the parts of augur-run's `src/scenario.ts` these scenarios use.

type Answer<T> = { status: number; ok: boolean; body: T };
type Api = {
  get: <T = unknown>(path: string, opts?: { floor?: string }) => Promise<Answer<T>>;
  post: <T = unknown>(path: string, body?: unknown, opts?: { floor?: string }) => Promise<Answer<T>>;
  upload: <T = unknown>(path: string, raw: string, type: string, opts?: { floor?: string }) => Promise<Answer<T>>;
};
type Persona = { key: string; name: string; floors: { key: string; id?: string; name: string }[]; roles: string[] };
type Context = {
  parts: Record<string, { persona: Persona; api: Api }>;
  personas: Persona[];
  as: (persona: Persona) => Api;
  cast: { synthetic: { note: string } };
  check: (label: string, ok: boolean, detail?: { expected?: unknown; actual?: unknown }) => boolean;
  note: (text: string, data?: unknown) => void;
  random: () => number;
  state: Record<string, unknown>;
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
  needs: { as: string; role?: string; floors?: 'own' | 'none' }[];
  run: (ctx: Context) => Promise<void>;
};

const FOLIO = '/api/folio/v1';
const WORKSPACES = '/api/identity/v1/me/workspaces';

type Floor = { id: string; kind: string; name: string; path?: string[] };
type Found = { documents: { id: string; libraryName?: string }[] };
type Kept = { library: string; libraryName: string; document: string; word: string; to: string; toName: string; author: string };

/** The library the scenario keeps on the author's own floor, and the one state it shows up the floors. */
const LIBRARY = 'Published up by the run suite';
const SHOWN = 'in-progress';

const floorsOf = async (api: Api) => {
  const r = await api.get<{ workspaces: Floor[] }>(WORKSPACES);
  return r.ok ? r.body.workspaces : undefined;
};

/** Whether someone stands on the floor, or on a floor inside it (which its readers include). */
const standsOn = (floors: Floor[], id: string) => floors.some((f) => f.id === id || f.path?.includes(id));

/** Makes the author's library, document and placement once, and keeps them for the runs after. */
const publishUp = async (ctx: Context, author: Persona, api: Api): Promise<Kept | undefined> => {
  const floors = await floorsOf(api);
  if (!ctx.check('the author’s floors can be read', !!floors)) return undefined;
  const own = floors!.find((f) => f.kind === 'personal');
  const to = floors!.find((f) => f.kind !== 'personal' && f.kind !== 'org');
  if (!ctx.check('the author has a floor of their own and a floor above it', !!own && !!to, { actual: floors!.map((f) => f.kind) })) return undefined;

  const made = await api.post<{ id: string; name: string }>(`${FOLIO}/libraries`, { name: LIBRARY }, { floor: own!.id });
  let library = made.ok ? made.body : undefined;
  if (!library && made.status === 409) {
    const all = await api.get<{ libraries: { id: string; name: string }[] }>(`${FOLIO}/libraries`, { floor: own!.id });
    library = all.ok ? all.body.libraries.find((l) => l.name === LIBRARY) : undefined;
  }
  if (!ctx.check('the author makes a library on their own floor', !!library, { actual: made.status })) return undefined;

  // A word no other document has, so Find answers with this one alone.
  const word = `floorcheck${Math.floor(ctx.random() * 1e9).toString(36)}`;
  const q = new URLSearchParams({ filename: `${word}.md`, title: `Published up the floors (${word})` });
  const text = `# Published up the floors\n\nShown to ${to!.name} while it is in progress.\n\n${ctx.cast.synthetic.note}`;
  const doc = await api.upload<{ id: string }>(`${FOLIO}/libraries/${encodeURIComponent(library!.id)}/documents?${q}`, text, 'text/markdown', { floor: own!.id });
  if (!ctx.check('the author adds a document to it', doc.ok, { actual: doc.status })) return undefined;

  const placed = await api.post(
    `${FOLIO}/placements`,
    { library: library!.id, record: { kind: 'document', id: doc.body.id }, to: to!.id, filter: [SHOWN] },
    { floor: own!.id },
  );
  if (!ctx.check(`the author publishes it up to ${to!.name}`, placed.status === 201, { expected: 201, actual: placed.status })) return undefined;
  return { library: library!.id, libraryName: library!.name, document: doc.body.id, word, to: to!.id, toName: to!.name, author: author.key };
};

/**
 * Publishing up the floors is counted in who can read (alpha Goal 30): a document published up from
 * someone's own floor is found and opened by the people of the floor it went to, under its library's real
 * name, and stays out of reach for everyone else.
 */
export const floorPublishing: Scenario = {
  id: 'RUN-15',
  title: 'Artifacts published up a floor are read there, and only there',
  owner: 'folio',
  goals: [30],
  cuj: 6,
  given: 'An editor on a floor, a person on the same floor, and a person on none of it.',
  when: 'The editor adds a document to a library on their own floor and publishes it up to their floor, while it is in progress. The others look for it and open it.',
  then: 'The person on that floor finds it, under its library’s name, and opens it; the person elsewhere neither finds it nor opens it, and is told why.',
  cadence: { kind: 'every', minutes: 120, quietMinutes: 360 },
  needs: [{ as: 'author', role: 'editor', floors: 'own' }],
  run: async (ctx) => {
    const { persona: author, api } = ctx.parts.author!;
    let kept = ctx.state.kept as Kept | undefined;
    if (!kept) {
      kept = await publishUp(ctx, author, api);
      if (!kept) return;
      ctx.state.kept = kept;
      ctx.note(`${author.name} published “${kept.word}” up to ${kept.toName}.`, kept);
    }

    // Who is on that floor, and who is on none of it, as identity says.
    let reader: { persona: Persona; floor: string } | undefined;
    let outsider: { persona: Persona; floor: string } | undefined;
    for (const p of ctx.personas) {
      if (p.key === kept.author || !p.floors.length || (reader && outsider)) continue;
      const floors = await floorsOf(ctx.as(p));
      const team = floors?.filter((f) => f.kind !== 'personal' && f.kind !== 'org');
      if (!team?.length) continue;
      if (!reader && standsOn(team, kept.to)) reader = { persona: p, floor: team.find((f) => f.id === kept.to || f.path?.includes(kept.to))!.id };
      else if (!outsider && !standsOn(team, kept.to)) outsider = { persona: p, floor: team[0]!.id };
    }

    if (reader) {
      const as = ctx.as(reader.persona);
      const found = await as.get<Found>(`${FOLIO}/find?q=${encodeURIComponent(kept.word)}`, { floor: reader.floor });
      const hit = found.ok ? found.body.documents.find((d) => d.id === kept.document) : undefined;
      ctx.check(`someone on ${kept.toName} finds what was published up to it`, !!hit, { actual: found.status });
      ctx.check('Find names its library by its real name', hit?.libraryName === kept.libraryName, { expected: kept.libraryName, actual: hit?.libraryName });
      const open = await as.get<{ id: string; only?: number }>(`${FOLIO}/documents/${encodeURIComponent(kept.document)}`, { floor: reader.floor });
      ctx.check(`someone on ${kept.toName} opens it`, open.ok, { actual: open.status });
      ctx.check('they open only the version published up', open.ok && typeof open.body.only === 'number', { actual: open.body });
    } else ctx.note(`Nobody else in the cast stands on ${kept.toName}, so nobody can look for it there.`);

    if (outsider) {
      const as = ctx.as(outsider.persona);
      const found = await as.get<Found>(`${FOLIO}/find?q=${encodeURIComponent(kept.word)}`, { floor: outsider.floor });
      ctx.check('someone on another floor doesn’t find it', found.ok && !found.body.documents.some((d) => d.id === kept.document), { actual: found.status });
      const open = await as.get<{ message?: string }>(`${FOLIO}/documents/${encodeURIComponent(kept.document)}`, { floor: outsider.floor });
      ctx.check('someone on another floor can’t open it', open.status === 404, { expected: 404, actual: open.status });
      ctx.check('the refusal says why', typeof open.body?.message === 'string' && open.body.message.length > 0, { actual: open.body });
    } else ctx.note(`Everyone in the cast stands on ${kept.toName}, so nobody can be turned away from it.`);
  },
};

export const scenarios = [floorPublishing];
