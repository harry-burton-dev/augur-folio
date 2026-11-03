import { Button, Card, Cards, List, State, Surface, relativeTime, type ListItem } from '@augur/app-kit';
import { useEffect, useState } from 'react';
import { stateName, type FloorView, type FolioApi, type LevelInfo, type ReceivedPage, type RecordView } from '../api.js';
import { folderTrail } from '../places.js';
import { filterWords, floorWords } from '../placements.js';

export interface ArrivedProps {
  api: FolioApi;
  /** The placement: something published up to this floor. */
  placement: string;
  levelName: (id: LevelInfo['id']) => string;
  /** Things that went on up, and where the person sees them now. */
  signposts: { record: RecordView; to?: FloorView }[];
  onBack: () => void;
  onRead: (library: string, document: string) => void;
  onFail: (err: unknown) => void;
}

/** Something published up to this floor: what it lets through, from where, and what's inside it, one folder at a time. */
export function Arrived({ api, placement, levelName, signposts, onBack, onRead, onFail }: ArrivedProps) {
  const [folder, setFolder] = useState<string>();
  const [page, setPage] = useState<ReceivedPage>();
  const [failure, setFailure] = useState('');
  useEffect(() => {
    let gone = false;
    setFailure('');
    api.receivedPage(placement, folder).then(
      (p) => !gone && setPage(p),
      (err: Error) => {
        if (gone) return;
        setFailure(err.message);
        onFail(err);
      },
    );
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, placement, folder]);

  if (failure) return <State kind="error" heading="Couldn’t open what came from below" body={failure} />;
  if (!page) return <State kind="loading" heading="Opening what came from below" />;
  const p = page.placement;
  const trail = folderTrail(page.folders, page.folder ?? undefined).filter((f) => f.id !== p.record.id);
  const folders = page.folders.filter((f) => (f.parent ?? null) === page.folder && f.id !== p.record.id);
  const rows: ListItem[] = page.documents.map((d) => ({
    id: `${d.library}/${d.id}`,
    title: d.title,
    icon: 'document',
    detail: [`Version ${d.latest.number}`, d.latest.state ? stateName(d.latest.state) : '', d.onlyVia ? `Shown here only: ${floorWords(d.onlyVia)} doesn’t show it` : ''].filter(Boolean).join(' · '),
    meta: relativeTime(d.latest.createdAt),
  }));
  const below = [...new Set(Object.values(page.states).filter((f) => f && f.id !== p.to).map((f) => floorWords(f)))];
  const back = trail.length ? { label: trail.at(-2)?.name ?? p.record.name ?? 'Back', go: () => setFolder(trail.at(-2)?.id) } : { label: 'From below', go: onBack };
  return (
    <div className="folio-arrived" data-folio-arrived="">
      <Button kind="ghost" onPress={back.go}>
        {back.label}
      </Button>
      <h1 className="text-title-s">{trail.at(-1)?.name ?? p.record.name ?? 'Published up to here'}</h1>
      <p className="text-meta text-ink-muted">From {floorWords(p.fromFloor)}</p>
      <p className="folio-note">
        {[`Showing ${filterWords(p.filter).toLowerCase()}.`, p.note ? `“${p.note}”` : '', below.length ? `Some versions show here only because ${below.join(' and ')} shows them.` : '', p.landed ? '' : 'It sits under From below until a lead here gives it a place.']
          .filter(Boolean)
          .join(' ')}
      </p>
      {folders.length ? (
        <Cards>
          {folders.map((f) => (
            <Card key={f.id} heading={f.name} icon="folder" meta={[levelName(f.level)]} note={f.description} noteTone="ink" onOpen={() => setFolder(f.id)} />
          ))}
        </Cards>
      ) : null}
      <Surface>
        <List
          label={`In ${p.record.name ?? 'it'}`}
          density="compact"
          noun={['document', 'documents']}
          items={rows}
          empty="Nothing here is in a state it lets through yet. It shows as soon as something is."
          onOpen={(item) => {
            const [library, document] = item.id.split('/');
            onRead(library!, document!);
          }}
        />
      </Surface>
      {signposts.length ? <p className="folio-note">{signposts.map((sp) => `${sp.record.name ?? 'Something'} went on up: you see it on ${floorWords(sp.to)}.`).join(' ')}</p> : null}
    </div>
  );
}
