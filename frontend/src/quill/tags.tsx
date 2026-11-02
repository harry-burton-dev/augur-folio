import { Button, Dialog, List, TextField, Toggle, type ListItem } from '@augur/app-kit';
import { useCallback, useEffect, useState } from 'react';
import type { FolioApi, OpenLibrary, Tag } from '../api.js';
import { nameCheck } from '../words.js';

export interface TagsDialogProps {
  api: FolioApi;
  library: OpenLibrary;
  onClose: () => void;
  /** Tags changed: read the collection again. */
  onChanged: () => Promise<unknown>;
}

/** A word typed to add as a tag, and what went wrong adding it. */
function AddTag({ label, taken, add }: { label: string; taken: readonly string[]; add: (name: string) => Promise<unknown> }) {
  const [word, setWord] = useState('');
  const [failed, setFailed] = useState('');
  const go = async () => {
    const name = word.trim();
    if (!name) return;
    const wrong = nameCheck(taken, 'tag', true, 40)(name);
    if (wrong) return setFailed(wrong.message);
    try {
      await add(name);
      setWord('');
      setFailed('');
    } catch (err) {
      setFailed((err as Error).message);
    }
  };
  return (
    <div
      className="folio-add-tag"
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || !(e.target instanceof HTMLInputElement)) return;
        e.preventDefault();
        void go();
      }}
    >
      <TextField label={label} maxLength={40} value={word} onChange={(v) => (setWord(v), setFailed(''))} state={failed ? 'error' : undefined} message={failed || undefined} />
      <Button kind="secondary" size="sm" onPress={() => void go()}>
        Add
      </Button>
    </div>
  );
}

/**
 * A collection's tags and the org's: rename or remove them, add new ones,
 * and whether anyone here may add tags. Documents are found by their tags.
 */
export function TagsDialog({ api, library, onClose, onChanged }: TagsDialogProps) {
  const [org, setOrg] = useState<{ tags: Tag[]; manage: boolean }>();
  const [target, setTarget] = useState<{ tag: Tag; doing: 'rename' | 'remove' }>();
  const loadOrg = useCallback(() => api.orgTags().then(({ tags, can }) => setOrg({ tags, manage: can.manage }), () => setOrg(undefined)), [api]);
  useEffect(() => void loadOrg(), [loadOrg]);

  const own = library.tags.filter((t) => t.library);
  const orgTags = org?.tags ?? library.tags.filter((t) => !t.library);
  const rows = (tags: Tag[], editable: boolean): ListItem[] =>
    tags.map((t) => ({ id: t.id, title: t.name, icon: t.library ? 'tag' : 'org', ...(editable ? { actions: [{ id: 'rename', label: 'Rename' }, { id: 'remove', label: 'Remove' }] } : {}) }));
  const act = (tags: Tag[]) => (item: ListItem, action: { id: string }) => {
    const tag = tags.find((t) => t.id === item.id);
    if (tag) setTarget({ tag, doing: action.id === 'rename' ? 'rename' : 'remove' });
  };
  const after = async (wasOrg: boolean) => {
    await onChanged();
    if (wasOrg) await loadOrg();
  };

  if (target?.doing === 'rename') {
    const { tag } = target;
    const same = (tag.library ? library.tags.filter((t) => t.library === tag.library || !t.library) : orgTags).filter((t) => t.id !== tag.id && (!tag.library || t.library)).map((t) => t.name);
    return (
      <Dialog
        open
        onClose={() => setTarget(undefined)}
        eyebrow={tag.library ? 'Tag' : 'Org tag'}
        heading={`Rename ${tag.name}`}
        summary={tag.library ? 'Every document with it keeps it.' : 'Every document with it keeps it, in every collection.'}
        actionLabel="Save"
        busyLabel="Saving…"
        onSubmit={(v) => api.renameTag(tag, v.name!.trim()).then(() => after(!tag.library))}
        fields={<TextField name="name" label="Name" required maxLength={40} defaultValue={tag.name} validate={nameCheck(same, 'tag', true, 40)} autoFocus />}
      />
    );
  }
  if (target?.doing === 'remove') {
    const { tag } = target;
    return (
      <Dialog
        open
        danger
        onClose={() => setTarget(undefined)}
        eyebrow={tag.library ? 'Tag' : 'Org tag'}
        heading={`Remove ${tag.name}?`}
        actionLabel="Remove"
        busyLabel="Removing…"
        onSubmit={() => api.deleteTag(tag).then(() => after(!tag.library))}
      >
        <p>It comes off every document that has it{tag.library ? '' : ', in every collection'}. The documents stay.</p>
      </Dialog>
    );
  }
  return (
    <Dialog open light size="read" onClose={onClose} eyebrow={library.name} heading="Tags" summary="Documents are found by their tags. The org’s tags are shared by every collection; this collection’s are its own." cancelLabel="Done">
      <div className="folio-document-dialog" data-folio-tags="">
        <List label={`${library.name}’s tags`} density="compact" noun={['tag', 'tags']} items={rows(own, library.can.manage)} empty="This collection has no tags of its own yet." onAction={act(own)} />
        {library.can.addTags ? <AddTag label="New tag" taken={library.tags.map((t) => t.name)} add={(name) => api.createTag(library.id, name).then(() => onChanged())} /> : null}
        {library.can.manage ? (
          <Toggle
            label="Anyone here can add tags"
            hint="Otherwise only the floor’s leads add them; everyone can still tag with the ones there are."
            checked={library.freeTags}
            onChange={(on) => api.updateLibrary(library.id, { freeTags: on }).then(() => onChanged())}
          />
        ) : null}
        <List
          label="The org’s tags"
          density="compact"
          noun={['org tag', 'org tags']}
          items={rows(orgTags, Boolean(org?.manage))}
          empty={org?.manage ? 'The org has no tags yet.' : 'The org has no tags yet. Its leads add them, on the org’s floor.'}
          onAction={act(orgTags)}
        />
        {org?.manage ? <AddTag label="New org tag" taken={orgTags.map((t) => t.name)} add={(name) => api.createTag(undefined, name).then(() => after(true))} /> : null}
      </div>
    </Dialog>
  );
}
