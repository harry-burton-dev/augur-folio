import { CONTAINER_LIFECYCLE } from '@augur/records';
import { Details, Dialog, Lifecycle, List, Tag, TagPicker, relativeTime, type ListItem } from '@augur/app-kit';
import { useCallback, useEffect, useState } from 'react';
import { CONTAINER_STATES, stateName, type ContainerState, type Folder, type FolioApi, type OpenLibrary, type RecordLink, type Tag as FolioTag } from '../api.js';
import type { PickRef } from '../links.js';
import { closedWords, stateOf } from '../places.js';
import { tagOptions } from '../words.js';
import { Links } from './links.js';

export interface PlaceDetailsProps {
  api: FolioApi;
  userId: string;
  library: OpenLibrary;
  /** The folder, when it's one; the collection itself otherwise. */
  folder?: Folder;
  /** What its level is called: "Collection", "Subcollection". */
  levelName: string;
  floorName: string;
  pickRef?: PickRef;
  onClose: () => void;
  /** It changed: read the collection again. */
  onChanged: () => Promise<unknown>;
  /** The collection was archived: it's gone from the shelf. */
  onArchived: () => void;
  onTags: (tags: FolioTag[]) => void;
  onOpenLink: (link: RecordLink) => void;
}

/**
 * A collection's or folder's details: what it is and is for, its tags (a
 * folder's count for everything inside it), where it is in its lifecycle and
 * how it got there, and its links.
 */
export function PlaceDetails({ api, userId, library, folder, levelName, floorName, pickRef, onClose, onChanged, onArchived, onTags, onOpenLink }: PlaceDetailsProps) {
  const [moves, setMoves] = useState<{ id: string; from: string; to: string; note?: string; at: string }[]>();
  const [moving, setMoving] = useState(false);
  const [note, setNote] = useState('');
  const state = stateOf(folder, library);
  const inside = library.folders.filter((f) => f.parent === folder?.id).length;
  const mayTag = Boolean(folder && (library.can.manage || folder.createdBy === userId));

  const loadMoves = useCallback(() => api.moves(library.id, folder ? { folder: folder.id } : {}).then((m) => setMoves(m.moves), () => setMoves([])), [api, library.id, folder]);
  useEffect(() => void loadMoves(), [loadMoves]);

  const move = async (to: ContainerState) => {
    setMoving(true);
    try {
      await api.setState(library.id, to, folder?.id);
      if (to === 'archived' && !folder) return onArchived();
      await onChanged();
      await loadMoves();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setMoving(false);
    }
  };
  const retag = async (tags: string[]) => {
    if (!folder) return;
    try {
      await api.setFolderTags(library.id, folder.id, tags);
      await onChanged();
    } catch (err) {
      setNote((err as Error).message);
    }
  };
  const newTag = async (name: string) => {
    try {
      const tag = await api.createTag(library.id, name);
      onTags([...library.tags, tag].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
      await retag([...(folder?.tags ?? []), tag.id]);
    } catch (err) {
      setNote((err as Error).message);
    }
  };
  const tags = folder?.tags ?? [];
  const history: ListItem[] = (moves ?? []).map((m) => ({ id: m.id, title: `${stateName(m.from)} to ${stateName(m.to)}`, detail: m.note ?? '', meta: relativeTime(m.at) }));

  return (
    <Dialog open light onClose={onClose} eyebrow={levelName} heading={folder?.name ?? library.name} cancelLabel="Close">
      <div className="folio-document-dialog" data-folio-details="">
        <Details
          missing="Not given"
          items={[
            { label: 'What it is', value: levelName },
            { label: 'What it’s for', value: (folder ? folder.description : library.description) || undefined },
            { label: 'State', value: closedWords(state) || `Open: ${CONTAINER_LIFECYCLE.get('open').meaning}` },
            { label: 'Inside it', value: inside ? `${inside} ${inside === 1 ? 'place' : 'places'}` : undefined },
            { label: 'Made', value: relativeTime(folder?.createdAt ?? library.createdAt) },
            { label: 'Last changed', value: relativeTime(folder?.updatedAt ?? library.updatedAt) },
            { label: 'Kept on', value: floorName || undefined },
          ]}
        />
        {folder && mayTag ? (
          <TagPicker label="Tags" placeholder="Add a tag" hint="They count for everything inside it when you filter." options={tagOptions(library.tags)} value={tags} onChange={(next) => void retag(next)} onCreate={library.can.addTags ? (name) => void newTag(name) : undefined} />
        ) : tags.length ? (
          <div className="folio-tags" aria-label="Tags">
            {tags.map((t) => {
              const tag = library.tags.find((x) => x.id === t);
              return tag ? <Tag key={t} quiet label={tag.name} icon={tag.library ? undefined : 'org'} /> : null;
            })}
          </div>
        ) : null}
        <Lifecycle
          label={folder?.name ?? library.name}
          states={CONTAINER_STATES}
          state={state}
          moves={CONTAINER_LIFECYCLE.movesFrom(state, library.can.manage ? 'manage' : undefined)}
          why="Only whoever manages the collection can close or archive it."
          busy={moving}
          onMove={(to) => void move(to as ContainerState)}
        />
        <section className="folio-reading-section" aria-label="Links">
          <span className="quill-label">Links</span>
          <Links api={api} library={library.id} record={{ kind: folder ? 'folder' : 'library', id: folder?.id ?? library.id, name: folder?.name ?? library.name }} pickRef={pickRef} onOpen={onOpenLink} />
        </section>
        {history.length ? <List label="Its lifecycle so far" density="compact" noun={['move', 'moves']} items={history} /> : null}
        {note ? (
          <p className="folio-note" role="status">
            {note}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
