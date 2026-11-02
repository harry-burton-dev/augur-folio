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
} from '@augur/app-kit';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CONTENT_STATES, fileTypeOf, sizeWords, stateName, type ContentState, type FolioApi, type OpenDocument, type RecordLink, type Tag as FolioTag } from '../api.js';
import type { PickRef } from '../folio-links.js';
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
    const saved = shown && stored.get(placeKey(shown.id));
    // Back where they were, without taking focus from wherever it is.
    if (saved && !restored.current && reader.current?.goTo(saved, { smooth: false, focus: false })) setCurrent(reader.current.headingFor(saved));
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
export function ReadingMain({ reading, backLabel, actions }: { reading: Reading; backLabel: string; actions: ReadingActions }) {
  const { doc, shown: v } = reading;
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
    <div className="folio-reading" data-wide={reading.prefs.wide || undefined}>
      <header className="folio-reading-head">
        <Button kind="ghost" size="sm" onPress={actions.onBack}>
          {backLabel}
        </Button>
        <h1 className="text-title-s">{doc.title}</h1>
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
      {body()}
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
  propose?: Propose;
  pickRef?: PickRef;
  /** "When it was published", in words: "3 h ago". */
  agoWords: (time: string) => string;
  onRead: (version?: number) => void;
  onDownload: (version: number) => void;
  onManage: () => void;
  onShare: () => void;
  onPublish: () => void;
  onPublishUp: () => void;
  onMove: (version: number, state: ContentState) => Promise<unknown>;
  onSeries: (series: string) => void;
  onFollow: (following: boolean) => Promise<unknown>;
  onOpenLink: (link: RecordLink) => void;
}

/** The drawer while reading: how to read it, what it is, where it is in its life, its links, and its versions. */
export function ReadingSide(props: ReadingSideProps) {
  const { reading, api, tags, propose, pickRef, agoWords } = props;
  const { doc, shown: v, prefs, setPrefs, passage } = reading;
  const [moving, setMoving] = useState(false);
  const [proposing, setProposing] = useState(false);
  const [proposed, setProposed] = useState<{ ok: boolean; words: string }>();
  useEffect(() => setProposed(undefined), [passage?.text, passage?.anchor]);
  if (!doc || !v) return null;
  const newest = doc.latest.number;
  const size = SIZES.indexOf(prefs.size);
  const versions: ListItem[] = doc.versions.map((x) => ({
    id: String(x.number),
    title: x.number === v.number ? `Version ${x.number}, reading` : `Version ${x.number}`,
    icon: 'document',
    detail: [stateName(x.state), sizeWords(x.size), x.number === newest ? 'newest' : '', x.number === doc.published?.version ? 'published' : ''].filter(Boolean).join(' · '),
    meta: ago(x.createdAt),
  }));
  const offer = async () => {
    if (!propose || !passage) return;
    setProposing(true);
    setProposed(undefined);
    try {
      setProposed({ ok: true, words: await propose({ id: doc.id, title: doc.title }, passage, v.number) });
    } catch (err) {
      setProposed({ ok: false, words: (err as Error).message });
    } finally {
      setProposing(false);
    }
  };
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
      <section className="folio-reading-section" aria-label="Text size">
        <span className="quill-label">Text size</span>
        <div className="folio-reading-row" role="group" aria-label="Text size">
          <Button kind="secondary" size="sm" disabled={size === 0} reason="It’s at the smallest size." onPress={() => setPrefs({ size: SIZES[size - 1] })}>
            Smaller
          </Button>
          <Button kind="secondary" size="sm" disabled={size === SIZES.length - 1} reason="It’s at the largest size." onPress={() => setPrefs({ size: SIZES[size + 1] })}>
            Larger
          </Button>
        </div>
        <Toggle label="Wide page" checked={prefs.wide} onChange={(wide) => setPrefs({ wide })} />
      </section>
      <div className="folio-reading-row">
        <Button kind="secondary" size="sm" onPress={() => props.onDownload(v.number)}>
          Download the original
        </Button>
        {doc.can.change ? (
          <Button kind="ghost" size="sm" onPress={props.onManage}>
            Change it
          </Button>
        ) : null}
        {doc.only ? null : (
          <Button kind="ghost" size="sm" onPress={props.onShare}>
            {doc.can.share ? 'Share' : 'Who can see it'}
          </Button>
        )}
      </div>
      {doc.only ? null : (
        <section className="folio-reading-section" aria-label="Lifecycle">
          <span className="quill-label">Version {v.number}</span>
          <Lifecycle
            label={`Version ${v.number}`}
            states={CONTENT_STATES}
            offLine={['retired']}
            state={v.state}
            moves={isNewest ? (doc.can.moves ?? []) : []}
            why={isNewest ? (doc.can.change ? 'Only whoever manages it can issue or retire it.' : 'Only whoever may change it can move it on.') : 'Only the newest version moves on.'}
            busy={moving}
            onMove={(state) => {
              setMoving(true);
              void props.onMove(v.number, state as ContentState).finally(() => setMoving(false));
            }}
          />
          <div>
            <Button kind="ghost" size="sm" onPress={props.onPublishUp}>
              Publish up the floors
            </Button>
          </div>
        </section>
      )}
      {publishing ? (
        <section className="folio-reading-section" aria-label="Publishing">
          <p className="folio-reading-said">
            <Icon name={doc.state === 'published' ? 'publish' : doc.state === 'withdrawn' ? 'withdraw' : 'document'} size={18} />
            {publishedWords}
          </p>
          {doc.published?.note && doc.only ? <p className="folio-reading-note">“{doc.published.note}”</p> : null}
          {doc.can.publish ? (
            <div>
              <Button kind="secondary" size="sm" onPress={props.onPublish}>
                {doc.state === 'published' ? 'Publishing' : 'Publish'}
              </Button>
            </div>
          ) : null}
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
          <Toggle label="Tell me of each new issue" checked={run.following} onChange={(on) => props.onFollow(on)} />
        </section>
      ) : null}
      <section className="folio-reading-section" aria-label="Links">
        <span className="quill-label">Links</span>
        <Links api={api} library={doc.library} record={{ kind: 'document', id: doc.id, name: doc.title }} pickRef={pickRef} onOpen={props.onOpenLink} />
      </section>
      {propose && v.reader.state === 'ready' ? (
        <section className="folio-reading-section" aria-label="Add to Data Atlas" ref={(el) => void (reading.keep.current = el)}>
          <span className="quill-label">Data Atlas</span>
          <p className="folio-reading-note">{passage ? `Marked: “${shortWords(passage.text)}”` : 'Select the words that name a ship, port, person or organisation, then add them to Data Atlas. Its leads decide what they are.'}</p>
          <div>
            <Button kind="secondary" size="sm" disabled={!passage} reason="Select some words in the document first." busy={proposing} busyLabel="Offering…" onPress={() => void offer()}>
              Add to Data Atlas
            </Button>
          </div>
          {proposed ? (
            <p className="folio-reading-note" data-refused={!proposed.ok || undefined} role={proposed.ok ? 'status' : 'alert'}>
              {proposed.words}
            </p>
          ) : null}
        </section>
      ) : null}
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
