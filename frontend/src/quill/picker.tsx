import { Button, Heading, List, Select, TextField, relativeTime, type ListItem, type SelectOption } from '@augur/app-kit';
import { useEffect, useRef, useState } from 'react';
import { fileTypeOf, type FolioApi, type FolioDocument, type Library } from '../api.js';

/** A document as the picker lists it: where it is, and which version is the person's to pick. */
type Pickable = FolioDocument & { libraryName: string; audienceOnly?: boolean };

/** What the picker answers with: a DocumentRef for Artifacts' document. */
export interface Picked {
  app: 'folio';
  id: string;
  version: string;
  title: string;
}

/** The version someone picks: the one published to them when that's all they may read, otherwise the newest. */
export const pickedOf = (d: Pickable): Picked => ({
  app: 'folio',
  id: d.id,
  version: String(d.audienceOnly && d.published ? d.published.version : d.latest.number),
  title: d.title,
});

export interface PickerProps {
  api: FolioApi;
  /** What the asking app says it's for: "Attach a policy". */
  purpose?: string;
  /** Media types the asking app takes; none for any. */
  accept?: string[];
  onPicked: (document: Picked) => void;
  onCancel: () => void;
}

/**
 * Artifacts answering `document.pick` for another app: find a document by
 * what's typed (its title, tags or words in it), or look through a library on
 * this floor or shared with the person, newest first. Only the kinds of file
 * the asking app takes are offered, and the rest are counted, not hidden.
 */
export function Picker({ api, purpose = '', accept = [], onPicked, onCancel }: PickerProps) {
  const [libraries, setLibraries] = useState<(Library & { shared?: boolean })[]>([]);
  const [library, setLibrary] = useState('');
  const [query, setQuery] = useState('');
  const [documents, setDocuments] = useState<Pickable[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState('');
  const asked = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  /** What's typed, or else the chosen library's documents, newest first. */
  const list = async (all: (Library & { shared?: boolean })[], lib: string, q: string) => {
    const mine = ++asked.current;
    setLoading(true);
    setFailure('');
    try {
      const typed = q.trim();
      const found: Pickable[] = typed
        ? (await api.find(typed)).documents
        : lib
          ? (await api.documents(lib, { below: true, sort: 'updated', limit: 50 })).documents.map((d) => ({ ...d, libraryName: all.find((l) => l.id === lib)?.name ?? '' }))
          : [];
      if (mine === asked.current) setDocuments(found);
    } catch (err) {
      if (mine === asked.current) setFailure((err as Error).message);
    } finally {
      if (mine === asked.current) setLoading(false);
    }
  };

  useEffect(() => {
    let live = true;
    void Promise.all([api.libraries(), api.shared()])
      .then(([{ libraries: own }, shared]) => {
        if (!live) return;
        const all = [...own, ...shared.libraries.map((l) => ({ ...l, shared: true }))];
        const first = all[0]?.id ?? '';
        setLibraries(all);
        setLibrary(first);
        return list(all, first, '');
      })
      .catch((err: Error) => {
        if (!live) return;
        setFailure(err.message);
        setLoading(false);
      });
    return () => {
      live = false;
      clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const search = (q: string) => {
    setQuery(q);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void list(libraries, library, q), 200);
  };

  const takes = (d: Pickable) => !accept.length || accept.includes(d.latest.mediaType);
  const offered = documents.filter(takes);
  const rows: ListItem[] = offered.map((d) => ({
    id: d.id,
    title: d.title,
    detail: [`In ${d.libraryName}`, `Version ${pickedOf(d).version}`, fileTypeOf(d.latest.filename)?.word].filter(Boolean).join(' · '),
    meta: relativeTime(d.updatedAt),
    icon: d.state === 'published' ? 'publish' : 'document',
  }));
  const options: SelectOption[] = libraries.map((l) => ({ value: l.id, label: l.shared ? `${l.name} (shared with you)` : l.name }));
  const hidden = documents.length - offered.length;
  const empty = query.trim()
    ? 'Nothing you can read matches that.'
    : libraries.length
      ? 'There’s nothing in this collection yet.'
      : 'There are no collections on this floor yet. Type to find a document anywhere you can read.';
  return (
    <div className="folio-picker" data-folio-picker>
      <Heading eyebrow="Pick from Artifacts" heading={purpose || 'Pick a document'} summary="Find one by its title, a tag or words in it, or look through a collection." />
      <div className="folio-picker-find">
        <TextField label="Find" placeholder="Title, tag or words in it" value={query} onChange={search} />
        {options.length && !query.trim() ? (
          <Select
            label="Library"
            options={options}
            value={library}
            onChange={(v) => {
              if (v === library) return;
              setLibrary(v);
              void list(libraries, v, query);
            }}
          />
        ) : null}
      </div>
      <List label="Documents to pick from" density="compact" noun={['document', 'documents']} items={rows} loading={loading} error={failure} empty={empty} onRetry={() => void list(libraries, library, query)} onOpen={(item) => {
          const doc = offered.find((d) => d.id === item.id);
          if (doc) onPicked(pickedOf(doc));
        }} />
      {hidden > 0 ? <p className="folio-picker-note" data-hidden>{hidden === 1 ? 'One other isn’t' : `${hidden} others aren’t`} the kind of file asked for.</p> : null}
      <div>
        <Button kind="tertiary" size="sm" onPress={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
