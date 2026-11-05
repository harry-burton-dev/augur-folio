import {
  Button,
  Contents,
  Icon,
  Lifecycle,
  List,
  Reader,
  State,
  Tag,
  Toggle,
  relativeTime,
  type ListItem,
  type MarkedPassage,
  type OutlineItem,
  type ReaderHandle,
  type ReaderSize,
  type RingSubject,
  useRingTarget,
} from '@augur/app-kit';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { CONTENT_STATES, fileTypeOf, sizeWords, stateName, type FolioApi, type OpenDocument, type RecordLink, type Tag as FolioTag } from '../api.js';
import type { PickRef } from '../links.js';
import { Links } from './links.js';

/** How a person likes to read, kept in their browser for every document. */
export interface ReadingPrefs {
  size: ReaderSize;
  wide: boolean;
}

const PREFS = 'folio:reading';
const SIZES: ReaderSize[] = ['small', 'medium', 'large'];

/** Storage that may not be there (private windows, blocked site data): reading still works without it. */
const stored = {
  get(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Not remembered this time.
    }
  },
};

export const readingPrefs = (): ReadingPrefs => {
  try {
    const saved = JSON.parse(stored.get(PREFS) ?? '{}') as Partial<ReadingPrefs>;
    return { size: SIZES.includes(saved.size as ReaderSize) ? (saved.size as ReaderSize) : 'medium', wide: saved.wide === true };
  } catch {
    return { size: 'medium', wide: false };
  }
};

/** Where someone got to in a version, by its block's anchor. */
const placeKey = (version: string) => `folio:read:${version}`;

/** A picture's name in a reader copy, as the worker writes them. */
const PICTURE = /^images\/(\d{1,5}\.png)$/;

/** Offers marked words to Data Atlas, and says where they went. */
export type Propose = (doc: { id: string; title: string }, passage: MarkedPassage, version: number) => Promise<string>;

const shortWords = (text: string) => (text.length > 80 ? `${text.slice(0, 79)}…` : text);

/** The paragraph a copied link names: the block's anchor after the #. */
const linkedAnchor = () => {
  try {
    return decodeURIComponent(window.location.hash.slice(1));
  } catch {
    return '';
  }
};

/** A link to this page at one block, to paste anywhere. */
export const paragraphLink = (anchor: string) => `${window.location.href.split('#')[0]}#${encodeURIComponent(anchor)}`;

/** "3 h ago", or "just now". */
const ago = (time: string) => relativeTime(time);

/**
 * Reading one version of a document: its reader copy, where the person got
 * to, its contents, how they like to read, and what they've marked. The
 * screen's main column, its contents and its drawer all read from this.
 */
export function useReading(api: FolioApi, doc: OpenDocument | undefined, version: number | undefined) {
  const shown = doc?.versions.find((v) => v.number === (version ?? doc.latest.number));
  const key = doc && shown?.reader.state === 'ready' ? `${shown.id}` : '';
  const [markdown, setMarkdown] = useState<string>();
  const [failure, setFailure] = useState('');
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [current, setCurrent] = useState('');
  const [prefs, setPrefsState] = useState(readingPrefs);
  const [passage, setPassage] = useState<MarkedPassage>();
  const reader = useRef<ReaderHandle>(null);
  const restored = useRef(false);
  const pictures = useRef<string[]>([]);
  /** The marked words stay while the person reaches for the Data Atlas button. */
  const keep = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setMarkdown(undefined);
    setFailure('');
    setOutline([]);
    setCurrent('');
    restored.current = false;
    if (!key || !doc || !shown) return;
    let gone = false;
    api.reader(doc.library, doc.id, shown.number).then(
      (text) => !gone && setMarkdown(text),
      (err: Error) => !gone && setFailure(err.message),
    );
    return () => {
      gone = true;
      for (const url of pictures.current) URL.revokeObjectURL(url);
      pictures.current = [];
    };
    // The key says which version is ready; a fresh copy of the same document mustn't reload it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, key]);

  useEffect(() => {
    const onSelection = () => {
      const marked = reader.current?.marked();
      if (marked) setPassage((was) => (was?.text === marked.text && was.anchor === marked.anchor ? was : marked));
      else if (!keep.current?.contains(document.activeElement)) setPassage(undefined);
    };
    document.addEventListener('selectionchange', onSelection);
    return () => document.removeEventListener('selectionchange', onSelection);
  }, []);

  const imageSource = useCallback(
    async (src: string) => {
      const name = src.match(PICTURE)?.[1];
      if (!doc || !shown || !name) return undefined;
      const url = URL.createObjectURL(await api.readerImage(doc.library, doc.id, shown.number, name));
      pictures.current.push(url);
      return url;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, key],
  );

  const onOutline = (headings: OutlineItem[]) => {
    setOutline(headings);
    const linked = linkedAnchor();
    const saved = shown && stored.get(placeKey(shown.id));
    // At the paragraph a link names, or else back where they were, without taking focus from wherever it is.
    for (const at of [linked, saved]) {
      if (at && !restored.current && reader.current?.goTo(at, { smooth: false, focus: false })) {
        setCurrent(reader.current.headingFor(at));
        break;
      }
    }
    restored.current = true;
  };
  const onPosition = (anchor: string) => {
    if (shown) stored.set(placeKey(shown.id), anchor);
    setCurrent(reader.current?.headingFor(anchor) ?? '');
  };
  const setPrefs = (change: Partial<ReadingPrefs>) =>
    setPrefsState((was) => {
      const next = { ...was, ...change };
      stored.set(PREFS, JSON.stringify(next));
      return next;
    });

  return { doc, shown, markdown, failure, outline, current, prefs, setPrefs, passage, reader, keep, imageSource, onOutline, onPosition };
}

export type Reading = ReturnType<typeof useReading>;

/** What the reader can ask of the page round it. */
export interface ReadingActions {
  onBack: () => void;
  /** Read another version; none for the newest. */
  onRead: (version?: number) => void;
  onIssue: (library: string, document: string) => void;
  onRetry: (version: number) => void;
}

/** The middle: the title, where it is, and the reader copy or why there isn't one yet. */
export function ReadingMain({ reading, backLabel, actions, ring, propose }: { reading: Reading; backLabel: string; actions: ReadingActions; ring: () => RingSubject | undefined; propose?: Propose }) {
  const { doc, shown: v } = reading;
  // The document's actions open on its head (right-click, a long press, or the mark by the title); the text keeps the browser's own menu.
  const head = useRingTarget(ring);
  const headEl = useRef<HTMLElement>(null);
  const root = useRef<HTMLDivElement>(null);
  /** The Actions button opens the same ring the head does, centred on the button, for the keyboard and touch. */
  const openActions = (button: Element | null) => {
    const r = button?.getBoundingClientRect();
    headEl.current?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, ...(r && r.width ? { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 } : {}) }));
  };
  if (!doc) return null;
  if (!v) return <State kind="empty" heading="There’s no such version of this document" />;
  const old = v.number !== doc.latest.number;
  const { run } = doc;
  const body = () => {
    switch (v.reader.state) {
      case 'queued':
      case 'running':
        return <State kind="loading" heading="Making the reader copy" body="It shows here as soon as it’s ready. The original can be downloaded now." />;
      case 'failed':
        return <State kind="error" heading="There’s no reader copy of this version" body={v.reader.error ?? 'Artifacts couldn’t make one.'} action={doc.can.change ? 'Try again' : undefined} onAction={() => actions.onRetry(v.number)} />;
      default:
        if (reading.failure) return <State kind="error" heading="The reader copy didn’t load" body={reading.failure} />;
        if (reading.markdown === undefined) return <State kind="loading" heading="Opening the document" />;
        return (
          <Reader
            ref={reading.reader}
            size={reading.prefs.size}
            width={reading.prefs.wide ? 'wide' : 'narrow'}
            markdown={reading.markdown}
            heading={doc.title}
            imageSource={reading.imageSource}
            onOutline={reading.onOutline}
            onPosition={reading.onPosition}
          />
        );
    }
  };
  return (
    <div className="folio-reading" data-wide={reading.prefs.wide || undefined} ref={root}>
      <header className="folio-reading-head" ref={headEl} {...head}>
        <Button kind="ghost" size="sm" onPress={actions.onBack}>
          {backLabel}
        </Button>
        <div className="folio-reading-title">
          <h1 className="text-title-s">{doc.title}</h1>
          <Button kind="ghost" size="sm" aria-haspopup="menu" onPress={(e) => openActions(e.target as Element)}>
            Actions
          </Button>
        </div>
        <p className="text-meta text-ink-muted">
          {[`Version ${v.number}`, fileTypeOf(v.filename)?.word, `added ${ago(v.createdAt)}`, v.reader.pages ? `${v.reader.pages} ${v.reader.pages === 1 ? 'page' : 'pages'}` : ''].filter(Boolean).join(' · ')}
        </p>
        {old ? (
          <p role="note">
            This is version {v.number}. The newest is version {doc.latest.number}.{' '}
            <button type="button" className="folio-link" onClick={() => actions.onRead()}>
              Read the newest
            </button>
          </p>
        ) : null}
        {run?.previous || run?.next ? (
          <nav className="folio-reading-turns" aria-label="Other issues">
            {run.previous ? (
              <Button kind="ghost" size="sm" onPress={() => actions.onIssue(run.previous!.library, run.previous!.id)}>
                Previous: {run.previous.period}
              </Button>
            ) : (
              <span />
            )}
            {run.next ? (
              <Button kind="ghost" size="sm" onPress={() => actions.onIssue(run.next!.library, run.next!.id)}>
                Next: {run.next.period}
              </Button>
            ) : null}
          </nav>
        ) : null}
      </header>
      <ReadingBar reading={reading} />
      {v.reader.state === 'ready' ? <SelectionBar reading={reading} root={root} propose={propose} /> : null}
      {body()}
    </div>
  );
}

/** Where the selected words are, inside the reading column, so the bar can sit just above them. */
const selectionAt = (root: HTMLElement | null) => {
  const selection = window.getSelection();
  if (!root || !selection?.rangeCount) return undefined;
  const r = selection.getRangeAt(0).getBoundingClientRect();
  if (!r.width && !r.height) return undefined;
  const box = root.getBoundingClientRect();
  return { top: r.top - box.top, left: r.left - box.left + r.width / 2 };
};

/**
 * What can be done with selected words, beside them: offer them to Data
 * Atlas, or copy a link that opens the document at their paragraph. The
 * browser's own menu stays on right-click.
 */
function SelectionBar({ reading, root, propose }: { reading: Reading; root: RefObject<HTMLDivElement | null>; propose?: Propose }) {
  const { doc, shown: v, passage } = reading;
  const [at, setAt] = useState<{ top: number; left: number }>();
  const [proposing, setProposing] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; words: string }>();
  useEffect(() => {
    setSaid(undefined);
    setAt(passage ? selectionAt(root.current) : undefined);
  }, [passage, root]);
  if (!doc || !v || !passage) return null;
  const offer = async () => {
    if (!propose) return;
    setProposing(true);
    setSaid(undefined);
    try {
      setSaid({ ok: true, words: await propose({ id: doc.id, title: doc.title }, passage, v.number) });
    } catch (err) {
      setSaid({ ok: false, words: (err as Error).message });
    } finally {
      setProposing(false);
    }
  };
  const copy = () => {
    const link = paragraphLink(passage.anchor);
    const copied = navigator.clipboard?.writeText(link) ?? Promise.reject(new Error('no clipboard'));
    copied.then(
      () => setSaid({ ok: true, words: 'Link copied. It opens this document at that paragraph.' }),
      () => setSaid({ ok: false, words: `Your browser didn’t let Artifacts copy it. The link is ${link}` }),
    );
  };
  return (
    <div
      className="folio-selection"
      role="toolbar"
      aria-label={`Marked: “${shortWords(passage.text)}”`}
      data-placed={at ? true : undefined}
      style={at ? { top: at.top, left: at.left } : undefined}
      ref={(el) => void (reading.keep.current = el)}
    >
      <span className="folio-selection-actions">
        {propose ? (
          <Button kind="secondary" size="sm" busy={proposing} busyLabel="Offering…" onPress={() => void offer()}>
            Add to Data Atlas
          </Button>
        ) : null}
        <Button kind="ghost" size="sm" onPress={copy}>
          Copy a link
        </Button>
      </span>
      {said ? (
        <p className="folio-reading-note" data-refused={!said.ok || undefined} role={said.ok ? 'status' : 'alert'}>
          {said.words}
        </p>
      ) : null}
    </div>
  );
}

/** Above the text: how it's read, not what it is. Remembered in the browser for every document. */
function ReadingBar({ reading }: { reading: Reading }) {
  const { prefs, setPrefs } = reading;
  const size = SIZES.indexOf(prefs.size);
  return (
    <div className="folio-reading-bar" role="toolbar" aria-label="Reading">
      <Button kind="ghost" size="sm" disabled={size === 0} reason="It’s at the smallest size." onPress={() => setPrefs({ size: SIZES[size - 1] })}>
        Smaller
      </Button>
      <Button kind="ghost" size="sm" disabled={size === SIZES.length - 1} reason="It’s at the largest size." onPress={() => setPrefs({ size: SIZES[size + 1] })}>
        Larger
      </Button>
      <Toggle label="Wide page" checked={prefs.wide} onChange={(wide) => setPrefs({ wide })} />
    </div>
  );
}

/** Beside the reader: the document's headings, the one being read marked. */
export function ReadingContents({ reading }: { reading: Reading }) {
  return <Contents items={reading.outline} current={reading.current} onSelect={(id) => reading.reader.current?.goTo(id)} />;
}

export interface ReadingSideProps {
  reading: Reading;
  api: FolioApi;
  /** The library's tags, to name the document's. */
  tags: FolioTag[];
  pickRef?: PickRef;
  /** "When it was published", in words: "3 h ago". */
  agoWords: (time: string) => string;
  onRead: (version?: number) => void;
  onSeries: (series: string) => void;
  onOpenLink: (link: RecordLink) => void;
}

/**
 * The drawer while reading is About: what it is, where it is in its life, its
 * links and its versions. What can be done to it is in its actions (on its
 * head), and how it's read is in the reading bar over the text.
 */
export function ReadingSide(props: ReadingSideProps) {
  const { reading, api, tags, pickRef, agoWords } = props;
  const { doc, shown: v } = reading;
  if (!doc || !v) return null;
  const newest = doc.latest.number;
  const versions: ListItem[] = doc.versions.map((x) => ({
    id: String(x.number),
    title: x.number === v.number ? `Version ${x.number}, reading` : `Version ${x.number}`,
    icon: 'document',
    detail: [stateName(x.state), sizeWords(x.size), x.number === newest ? 'newest' : '', x.number === doc.published?.version ? 'published' : ''].filter(Boolean).join(' · '),
    meta: ago(x.createdAt),
  }));
  const publishing = doc.issue || doc.only || doc.state === 'published';
  const publishedWords = doc.only
    ? `Version ${doc.only} was published to you${doc.published ? ` ${agoWords(doc.published.publishedAt)}` : ''}.`
    : doc.state === 'published' && doc.published
      ? `Version ${doc.published.version} was published ${agoWords(doc.published.publishedAt)}.`
      : doc.state === 'withdrawn'
        ? 'It was published, and has been withdrawn.'
        : 'A draft: it hasn’t been published.';
  const { run, issue } = doc;
  const isNewest = v.number === newest;

  return (
    <div className="folio-reading-side">
      {doc.only ? null : (
        <section className="folio-reading-section" aria-label="Lifecycle">
          <span className="quill-label">Version {v.number}</span>
          <Lifecycle label={`Version ${v.number}`} states={CONTENT_STATES} offLine={['retired']} state={v.state} />
          {isNewest && doc.can.moves?.length ? <p className="folio-reading-note">Move it on from Actions, by its title.</p> : null}
        </section>
      )}
      {publishing ? (
        <section className="folio-reading-section" aria-label="Publishing">
          <p className="folio-reading-said">
            <Icon name={doc.state === 'published' ? 'publish' : doc.state === 'withdrawn' ? 'withdraw' : 'document'} size={18} />
            {publishedWords}
          </p>
          {doc.published?.note && doc.only ? <p className="folio-reading-note">“{doc.published.note}”</p> : null}
        </section>
      ) : null}
      {run && issue ? (
        <section className="folio-reading-section" aria-label="Series">
          <p className="folio-reading-said">
            <Icon name="series" size={18} />
            <span>
              {issue.period.startsWith('Issue') ? `Issue ${issue.number}` : `Issue ${issue.number}, ${issue.period}`}, in{' '}
              <button type="button" className="folio-link" onClick={() => props.onSeries(run.id)}>
                {run.name}
              </button>
            </span>
          </p>
          {run.following ? <p className="folio-reading-note">You’re told of each new issue.</p> : null}
        </section>
      ) : null}
      <section className="folio-reading-section" aria-label="Links">
        <span className="quill-label">Links</span>
        <Links api={api} library={doc.library} record={{ kind: 'document', id: doc.id, name: doc.title }} pickRef={pickRef} onOpen={props.onOpenLink} />
      </section>
      {doc.tags.length ? (
        <div className="folio-tags" aria-label="Tags">
          {doc.tags.map((t) => {
            const tag = tags.find((x) => x.id === t);
            return tag ? <Tag key={t} quiet label={tag.name} icon={tag.library ? undefined : 'org'} /> : null;
          })}
        </div>
      ) : null}
      <List label="Versions" density="compact" noun={['version', 'versions']} items={versions} bar={false} onOpen={(item) => props.onRead(Number(item.id) === newest ? undefined : Number(item.id))} />
    </div>
  );
}
