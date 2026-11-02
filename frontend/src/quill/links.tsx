import { Button, List, Select, State, type ListItem, type SelectOption } from '@augur/app-kit';
import { useCallback, useEffect, useState } from 'react';
import type { FolioApi, RecordLink, RecordLinks, RecordView, RelationKind } from '../api.js';
import { linkRow as litRow, relationTarget, type LinkRef, type PickRef } from '../folio-links.js';

/** A link as a row; its icons are the kit's own. */
const linkRow = (l: RecordLink, change: boolean) => litRow(l, change) as ListItem;

/** The app a link's other end is in, by name. */
const APP_NAMES: Record<string, string> = { atlas: 'Data Atlas', mandate: 'Mandate' };

interface Linkable {
  id: string;
  kind: RecordView['kind'];
  name: string;
}

export interface LinksProps {
  api: FolioApi;
  library: string;
  record: { kind: RecordView['kind']; id: string; name: string };
  /** Asks the person for a thing in Data Atlas or an intent in Mandate; without it, `about` and `serves` links can't be made here. */
  pickRef?: PickRef;
  /** Open the other end of a link. */
  onOpen: (link: RecordLink) => void;
}

/**
 * A record's relationships: what it links to (others in Artifacts, things in
 * Data Atlas, intents in Mandate) and what links to it. Whoever may change the
 * record adds and removes its links. A linked record the person can't open
 * stays and says so; a kind of link they can't make from here says why.
 */
export function Links({ api, library, record, pickRef, onOpen }: LinksProps) {
  const [data, setData] = useState<RecordLinks>();
  const [failure, setFailure] = useState('');
  const [linkable, setLinkable] = useState<Linkable[]>([]);
  const [relation, setRelation] = useState<RelationKind['id']>('relates-to');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setFailure('');
    try {
      const got = await api.links(library, record.id);
      setData(got);
      if (got.can.change) {
        const [open, { documents }] = await Promise.all([api.library(library), api.documents(library, { below: true, limit: 200 })]).catch(() => [undefined, { documents: [] }] as const);
        setLinkable(
          [
            ...(open && record.id !== library ? [{ id: library, kind: 'library' as const, name: open.name }] : []),
            ...(open?.folders ?? []).map((f) => ({ id: f.id, kind: 'folder' as const, name: f.name })),
            ...documents.map((d) => ({ id: d.id, kind: 'document' as const, name: d.title })),
          ].filter((r) => r.id !== record.id),
        );
      }
    } catch (err) {
      setFailure((err as Error).message);
    }
  }, [api, library, record.id]);
  useEffect(() => {
    setData(undefined);
    void load();
  }, [load]);

  const why = (r: RelationKind['id']) => {
    const t = relationTarget(r);
    return t !== 'folio' && !pickRef ? `${APP_NAMES[t]} isn’t open to you from here.` : '';
  };

  const add = async () => {
    const t = relationTarget(relation);
    let to: LinkRef;
    if (t === 'folio') to = { app: 'folio', kind: 'unit', id: `${library}/${target}` };
    else {
      try {
        const picked = await pickRef!(t);
        if (!picked) return;
        to = picked;
      } catch (err) {
        setNote((err as Error).message);
        return;
      }
    }
    setBusy(true);
    try {
      const made = await api.link(library, record.id, relation, to);
      setNote(`${record.name} ${made.words.toLowerCase()} ${made.to?.label ?? 'it'} now.`);
      setTarget('');
      await load();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (id: string) => {
    try {
      await api.unlink(library, record.id, id);
      setNote('Unlinked.');
      await load();
    } catch (err) {
      setNote((err as Error).message);
    }
  };

  const open = (item: ListItem, list: readonly RecordLink[]) => {
    const link = list.find((l) => l.id === item.id);
    const end = link?.to ?? link?.from;
    if (link && end && !('unavailable' in end)) onOpen(link);
  };

  if (failure) return <State kind="error" heading="Couldn’t see its links" body={failure} action="Try again" onAction={() => void load()} />;
  if (!data) return <State kind="loading" heading="Seeing what it links to" />;
  const rows = data.links.map((l) => linkRow(l, data.can.change));
  const back = data.back.map((l) => linkRow(l, false));
  const kinds: SelectOption[] = data.kinds.map((k) => {
    const w = why(k.id);
    return { value: k.id, label: k.name, ...(w ? { disabled: true, detail: w } : {}) };
  });
  const toFolio = relationTarget(relation) === 'folio';
  const targets: SelectOption[] = linkable.map((r) => ({ value: r.id, label: r.name, detail: r.kind === 'library' ? 'The library' : r.kind === 'folder' ? 'Folder' : 'Document' }));
  const ready = toFolio ? Boolean(target) : !why(relation);

  return (
    <div className="folio-links">
      {rows.length ? <List label="What it links to" density="compact" noun={['link', 'links']} items={rows} onOpen={(i) => open(i, data.links)} onAction={(i) => void unlink(i.id)} /> : null}
      {back.length ? <List label="What links to it" density="compact" noun={['link', 'links']} items={back} onOpen={(i) => open(i, data.back)} /> : null}
      {!rows.length && !back.length ? <p className="folio-links-hint">Nothing links to or from it yet. Links say what supersedes what, what answers what, and what it’s about.</p> : null}
      {data.can.change ? (
        <section className="folio-links-form" aria-label="Link it">
          <Select label="Link it" options={kinds} value={relation} onChange={(v) => setRelation(v as RelationKind['id'])} />
          {toFolio ? (
            <Select
              label="To"
              placeholder="Choose from this collection"
              options={targets}
              value={target || null}
              onChange={setTarget}
              hint={targets.length ? 'Something in another collection links here from there.' : 'There’s nothing else in this collection yet.'}
            />
          ) : null}
          <div>
            <Button kind="secondary" size="sm" disabled={!ready} reason={toFolio ? 'Choose what it links to first.' : why(relation)} busy={busy} busyLabel="Linking…" onPress={() => void add()}>
              {toFolio ? 'Link' : `Choose in ${APP_NAMES[relationTarget(relation)]}`}
            </Button>
          </div>
        </section>
      ) : (
        <p className="folio-links-hint">Only whoever may change it can link it to something.</p>
      )}
      <p className="folio-note" role="status">
        {note}
      </p>
    </div>
  );
}
