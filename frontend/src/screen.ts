import type { QuillRemoteElementName, QuillRemoteEvents, QuillRemoteProperties } from '@augur/app-kit/remote';
import type { AppContext, RemoteElement, RemoteNode } from '@augur/mfe-sdk/sdk3';
import manifest from '../../manifest.json';
import type { Home, HomeItem } from '../../service/src/api-types.js';

/**
 * What Artifacts draws: Quill's remote elements by name, with their props (`@augur/app-kit/remote` types
 * them; nothing of the kit is bundled). The shell draws them with the real kit, the frame round them
 * (app bar, rail, About panel) from the manifest, and drops anything else.
 * A prop `on<Event>` hears that event: `onOpen` on a `quill-list`, `onAction` on a `quill-state`.
 */
type Handlers<N extends QuillRemoteElementName> = {
  [E in keyof QuillRemoteEvents[N] & string as `on${Capitalize<E>}`]?: (detail: QuillRemoteEvents[N][E]) => void;
};
export const quill = <N extends QuillRemoteElementName>(type: N, props: QuillRemoteProperties[N] & Handlers<N>, children?: RemoteNode): RemoteElement => ({
  type,
  props,
  ...(children === undefined ? {} : { children }),
});

/** The About sections the app fills: each is declared in manifest.json, which the shell draws from. */
export const ABOUT = Object.fromEntries(manifest.contributes.about.map((a) => [a.id, a.id])) as Record<string, string>;

/** Where the gateway sends the app's calls: its own inbound part, at its manifest id. */
export const API = `/api/${manifest.id}/v1`;

/** What Home shows of the service's answer. */
export type Asked = { kind: 'asking' } | { kind: 'answered'; home: Home } | { kind: 'failed'; why: string };

const rows = (items: HomeItem[]) => items.map(({ id, title, detail }) => ({ id, title, ...(detail ? { detail } : {}), thing: { kind: 'document' } }));

/**
 * Home (Endstate principle 2): what needs you comes first and lit, then what's new since you looked.
 * Every item is shown; nothing waits behind a pull.
 */
export const home = (asked: Asked, on: { retry: () => void; open: (item: HomeItem) => void }): RemoteNode => {
  if (asked.kind === 'asking') return quill('quill-state', { kind: 'loading', heading: 'Finding what needs you', size: 'region' });
  if (asked.kind === 'failed') return quill('quill-state', { kind: 'error', heading: `${manifest.name} couldn’t open Home`, body: asked.why, action: 'Try again', size: 'region', onAction: on.retry });
  const { needsYou, latest } = asked.home;
  const opener = (items: HomeItem[]) => (id: string) => {
    const item = items.find((i) => i.id === id);
    if (item) on.open(item);
  };
  return [
    quill(
      'quill-section',
      { label: 'Needs you', count: needsYou.length },
      quill('quill-list', { label: 'Needs you', noun: ['document', 'documents'], items: rows(needsYou), empty: 'Nothing needs you on this floor.', onOpen: opener(needsYou) }),
    ),
    quill(
      'quill-section',
      { label: 'New since you looked', count: latest.length },
      quill('quill-list', { label: 'New since you looked', noun: ['document', 'documents'], items: rows(latest), empty: 'Nothing new on this floor since you last looked.', onOpen: opener(latest) }),
    ),
  ];
};

/** The card on Home: how many things need the person here, and how many are new. */
export const card = (asked: Asked): RemoteNode =>
  asked.kind === 'answered'
    ? quill('quill-facts', {
        items: [
          { value: asked.home.needsYou.length, label: 'need you' },
          { value: asked.home.latest.length, label: 'new since you looked' },
        ],
      })
    : asked.kind === 'failed'
      ? quill('quill-state', { kind: 'error', heading: `${manifest.name} couldn’t say`, body: asked.why, size: 'line' })
      : quill('quill-facts', { loading: true, count: 2 });

/** An About section with no document open: what it will hold, said plainly. */
export const nothingOpen = (label: string): RemoteNode => quill('quill-state', { kind: 'empty', heading: `${label}: open a document to see this.`, size: 'line' });

/** The About panel on Home: which floor, and the app's version. */
export const floorFacts = (ctx: AppContext): RemoteNode =>
  quill('quill-details', {
    items: [
      { label: 'Floor', value: ctx.workspace.name },
      { label: 'Version', value: manifest.version },
    ],
  });

/** Why a call failed, from the problem details body every AUGUR service answers with (`detail` is the sentence). */
export const why = async (res: Response): Promise<string> => {
  const problem = (await res.json().catch(() => undefined)) as { detail?: string; message?: string } | undefined;
  return problem?.detail ?? problem?.message ?? `The service answered ${res.status}.`;
};
