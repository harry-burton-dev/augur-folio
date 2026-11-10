import { CONTENT_LIFECYCLE } from '@augur/records';
import type { Workspace, RemoteNode } from '@augur/mfe-sdk/sdk3';
import type { DocumentAnswer, GrantView, MoveView, PlacementsAnswer, ReaderAnswer, VersionView } from '../../service/src/api-types.js';
import { floorName, signpostNotice, statesLine, trailOf, type Load } from './library.js';
import { quill } from './screen.js';

/**
 * The Document screen is the reader (spec section 6): title, state and version in the page head, the
 * reading bar over the text, the version's history under it. About holds facts: its lifecycle, where it
 * is, who can open it, its chain up the floors and its links.
 */

export interface DocumentData {
  answer: DocumentAnswer;
  /** The version on screen. */
  version: VersionView;
  reader: ReaderAnswer;
  grants: GrantView[];
  /** Its steps up the floors; undefined when they couldn't be asked. */
  placements?: PlacementsAnswer;
}

/** The version a person sees first: a reader gets the newest Issued one, when there is one; anyone who can change it, the newest. */
export const shownVersion = (answer: DocumentAnswer, number?: number): VersionView | undefined =>
  number ? answer.versions.find((v) => v.number === number) : answer.rights.level === 'read' && answer.document.issued ? answer.versions.find((v) => v.number === answer.document.issued!.number) : answer.versions[0];

const stateName = (state: string) => (CONTENT_LIFECYCLE.states.some((s) => s.id === state) ? CONTENT_LIFECYCLE.get(state as never).name : state);
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

export interface DocumentOn {
  retry: () => void;
  trail: (id: string) => void;
  version: (number: number) => void;
  download: () => void;
  readAgain: () => void;
}

/** What the reader shows: the copy, or what's happening to it, or why there's none and what to do. */
const reading = (data: DocumentData, on: DocumentOn): RemoteNode => {
  const { reader, answer, version } = data;
  if (reader.state === 'ready' && reader.markdown !== undefined)
    return quill('quill-reader', { markdown: reader.markdown, title: answer.document.title, remember: 'folio.reader', contentsHeading: 'Contents' });
  if (reader.state === 'queued' || reader.state === 'working')
    return quill('quill-state', { kind: 'loading', heading: 'Making a copy to read here', body: reader.why ?? 'It usually takes a minute.', size: 'region' });
  if (reader.state === 'failed')
    return quill('quill-state', {
      kind: 'error',
      heading: 'There’s no copy to read here',
      body: reader.why ?? '',
      size: 'region',
      ...(reader.retry ? { action: 'Ask again', onAction: on.readAgain } : { action: `Download ${version.filename}`, onAction: on.download }),
    });
  return quill('quill-state', { kind: 'empty', heading: 'This one can’t be read here', body: reader.why ?? '', action: `Download ${version.filename}`, size: 'region', onAction: on.download });
};

const moveLine = (m: MoveView) => `${m.from ? `${stateName(m.from)} → ` : ''}${stateName(m.to)}${m.version ? ` (version ${m.version})` : ''}`;

export const documentScreen = (load: Load<DocumentData>, on: DocumentOn): RemoteNode => {
  if (load.kind === 'asking') return quill('quill-state', { kind: 'loading', heading: 'Opening the document', size: 'region' });
  if (load.kind === 'failed') return quill('quill-state', { kind: 'error', heading: 'The document couldn’t open', body: load.why, action: 'Try again', size: 'region', onAction: on.retry });
  const { answer, version } = load.value;
  const { document, versions } = answer;
  const newest = versions[0]!;
  return [
    quill('quill-page-head', {
      trail: trailOf(answer.path),
      eyebrow: `${stateName(version.state)} · version ${version.number}${version.number !== newest.number ? ` of ${newest.number}` : ''}`,
      heading: document.title,
      summary: `${version.filename} · ${size(version.size)} · added ${day(version.createdAt)}${version.createdByName ? ` by ${version.createdByName}` : ''}`,
      onTrail: on.trail,
    }),
    answer.reached
      ? quill('quill-notice', { tone: 'info', label: 'Published up', heading: `Published up to ${floorName(answer.reached.floor)}.` }, [answer.rights.why ?? ''])
      : document.placed
        ? signpostNotice(document.placed, 'it')
        : null,
    reading(load.value, on),
    // History sits under the content (App patterns, 9 November).
    quill('quill-section', { label: 'Versions', count: versions.length }, [
      quill('quill-list', {
        label: 'Versions',
        noun: ['version', 'versions'],
        density: 'compact',
        items: versions.map((v) => ({
          id: String(v.number),
          title: `Version ${v.number}${v.number === version.number ? ' (on screen)' : ''}`,
          detail: [stateName(v.state), v.filename, `added ${day(v.createdAt)}${v.createdByName ? ` by ${v.createdByName}` : ''}`].join(' · '),
          icon: 'document',
        })),
        onOpen: (id: string) => on.version(Number(id)),
      }),
    ]),
  ];
};

/** About, Lifecycle: where the version is, and every move it has made. */
export const lifecycleAbout = (data: DocumentData): RemoteNode => {
  const { answer, version } = data;
  const issued = answer.document.issued;
  return [
    quill('quill-details', {
      items: [
        { label: 'State', value: stateName(version.state), note: CONTENT_LIFECYCLE.get(version.state).meaning },
        { label: 'Version', value: `${version.number} of ${answer.versions.length}` },
        { label: 'Issued', value: issued ? `Version ${issued.number}` : 'Not yet' },
      ],
    }),
    quill('quill-list', {
      label: 'Moves',
      noun: ['move', 'moves'],
      density: 'compact',
      look: 'plain',
      items: answer.moves.slice(0, 20).map((m, i) => ({ id: String(i), title: moveLine(m), detail: `${m.byName ?? m.by} · ${when(m.at)}${m.note ? ` · “${m.note}”` : ''}` })),
      empty: 'No moves yet.',
    }),
  ];
};

/** About, Where it is: the floor and the path down to it. */
export const placeAbout = (data: DocumentData, floor: Workspace): RemoteNode =>
  quill('quill-details', {
    items: [
      {
        label: 'Floor',
        value: data.answer.floor.id === floor.id ? floor.name : data.answer.reached ? `Published up to ${floorName(data.answer.reached.floor)} from the floor that keeps it` : 'Another floor, which shared it with you',
      },
      { label: 'In', value: data.answer.path.map((s) => s.name).join(' › ') || 'The library' },
    ],
  });

/** About, Who can open it: the floor by its roles, then everyone it was shared with. */
export const accessAbout = (data: DocumentData, floor: Workspace, share: () => void): RemoteNode => {
  const { grants, answer } = data;
  return [
    quill('quill-details', {
      items: [
        { label: 'On its floor', value: answer.floor.kind === 'personal' ? (answer.floor.id === floor.id ? 'Only you' : 'Only the person whose floor it is') : 'Its leads manage it, its editors change it, everyone else on it reads it' },
        { label: 'You', value: `Can ${answer.rights.level}` },
      ],
    }),
    quill('quill-list', {
      label: 'Shared with',
      noun: ['person or team', 'people and teams'],
      density: 'compact',
      look: 'plain',
      items: grants.map((g) => ({ id: g.principal, title: g.name ?? g.principal, detail: `Can ${g.level}${g.kind !== 'document' ? ` (shared on the ${g.kind})` : ''}`, icon: g.principal.startsWith('person:') ? 'person' : 'people' })),
      empty: 'It hasn’t been shared with anyone off the floor.',
    }),
    answer.rights.share ? quill('quill-button', { label: 'Share', kind: 'secondary', size: 'sm', icon: 'people', onPress: share }) : null,
  ];
};

/** About, Up the floors: its own floor, then every floor it was published up to, the owner marked. */
export const floorsAbout = (data: DocumentData, floor: Workspace, publish: () => void): RemoteNode => {
  const up = data.placements;
  if (!up) return quill('quill-state', { kind: 'error', heading: 'Its steps up the floors couldn’t be asked for.', size: 'line' });
  const here = floor.kind === 'org' ? 'org' : floor.id;
  const live = up.placements.filter((p) => !p.ended).sort((a, b) => b.to.rank - a.to.rank);
  const open = up.targets.filter((t) => !t.why);
  return [
    quill('quill-floor-path', {
      label: 'Up the floors',
      floors: [
        { id: up.own.id, kind: up.own.kind, name: up.own.name, line: 'Kept here', owner: up.owner.id === up.own.id, here: up.own.id === here },
        ...live.map((p) => ({
          id: p.to.id,
          kind: p.to.kind,
          name: p.to.name,
          line: `Shows ${statesLine(p.filter).toLowerCase()}${p.landed ? `, in ${p.landed.name}` : ', under From below'}`,
          owner: up.owner.id === p.to.id,
          here: p.to.id === here,
        })),
      ],
    }),
    up.targets.length
      ? quill('quill-button', { label: 'Publish up', kind: 'secondary', size: 'sm', icon: 'publish', ...(open.length ? {} : { disabled: true, reason: up.targets[0]?.why ?? 'It’s on every floor above it can reach.' }), onPress: publish })
      : null,
  ];
};

/** About, Links: none yet; they come with publishing up. */
export const linksAbout = (): RemoteNode => quill('quill-state', { kind: 'empty', heading: 'Links to other documents and to what it’s about come in the next version of Artifacts.', size: 'line' });
