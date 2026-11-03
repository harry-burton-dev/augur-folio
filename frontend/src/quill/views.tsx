import { Button, Dialog, Menu, TextField, type MenuEntry } from '@augur/app-kit';
import { useState } from 'react';
import type { FolioApi, OpenLibrary, SavedView, ViewQuery } from '../api.js';
import { nameCheck } from '../words.js';

const same = (a: ViewQuery, b: ViewQuery) => {
  const norm = (q: ViewQuery) => JSON.stringify(Object.entries(q).sort(([x], [y]) => x.localeCompare(y)));
  return norm(a) === norm(b);
};

/** Naming the filters and sort on screen as a view, for everyone who can see the collection. */
export function SaveView({ api, library, query, onClose, onSaved }: { api: FolioApi; library: OpenLibrary; query: ViewQuery; onClose: () => void; onSaved: (view: SavedView) => void }) {
  return (
    <Dialog
      open
      onClose={onClose}
      eyebrow={library.name}
      heading="Save this view"
      summary="It goes in the views menu, for everyone who can see this collection."
      actionLabel="Save"
      busyLabel="Saving…"
      onSubmit={async (v) => onSaved(await api.createView(library.id, v.name!.trim(), query))}
      fields={<TextField name="name" label="Name" required maxLength={60} validate={nameCheck(library.views.map((x) => x.name), 'view', true, 60)} autoFocus />}
    />
  );
}

export interface ViewsMenuProps {
  api: FolioApi;
  library: OpenLibrary;
  userId: string;
  /** The saved view on screen, if one is. */
  current?: SavedView;
  /** The filters and sort on screen, as a view keeps them. */
  query: ViewQuery;
  /** Something is filtered or sorted, so there's a view to save. */
  changed: boolean;
  onOpen: (view: SavedView) => void;
  onSaved: (view: SavedView) => void;
  onRenamed: () => void;
  onDeleted: () => void;
}

/**
 * A collection's saved views, beside its filter bar: open one, save what's on
 * screen as a new one, save changes to the one open, rename or delete it
 * (whoever saved it, or a lead).
 */
export function ViewsMenu({ api, library, userId, current, query, changed, onOpen, onSaved, onRenamed, onDeleted }: ViewsMenuProps) {
  const [doing, setDoing] = useState<'save' | 'rename' | 'delete'>();
  const mayChange = Boolean(current && (library.can.manage || current.createdBy === userId));
  const differs = Boolean(current && !same(current.query, query));
  const items: MenuEntry[] = [
    ...library.views.map((v) => ({ id: `open:${v.id}`, label: v.id === current?.id ? `${v.name} (open)` : v.name, icon: 'view' as const })),
    ...(library.views.length ? ['-' as const] : []),
    ...(current && differs ? [{ id: 'update', label: 'Save changes', ...(mayChange ? {} : { disabled: true, reason: 'Only whoever saved it, or a lead, can change it.' }) }] : []),
    { id: 'save', label: current ? 'Save as a new view' : 'Save this view', ...(changed || differs ? {} : { disabled: true, reason: 'Filter or sort what’s here first.' }) },
    ...(current
      ? [
          { id: 'rename', label: `Rename ${current.name}`, ...(mayChange ? {} : { disabled: true, reason: 'Only whoever saved it, or a lead, can rename it.' }) },
          { id: 'delete', label: `Delete ${current.name}`, danger: true, ...(mayChange ? {} : { disabled: true, reason: 'Only whoever saved it, or a lead, can delete it.' }) },
        ]
      : []),
  ];
  const act = (id: string) => {
    if (id.startsWith('open:')) {
      const view = library.views.find((v) => `open:${v.id}` === id);
      if (view) onOpen(view);
    } else if (id === 'update' && current) void api.updateView(library.id, current.id, { query }).then(onRenamed);
    else setDoing(id as 'save' | 'rename' | 'delete');
  };
  return (
    <>
      <Menu label="Saved views" items={items} onAction={act} placement="bottom end">
        <Button kind="ghost" size="sm">
          {library.views.length ? `Views (${library.views.length})` : 'Views'}
        </Button>
      </Menu>
      {doing === 'save' ? <SaveView api={api} library={library} query={query} onClose={() => setDoing(undefined)} onSaved={onSaved} /> : null}
      {doing === 'rename' && current ? (
        <Dialog
          open
          onClose={() => setDoing(undefined)}
          eyebrow="View"
          heading={`Rename ${current.name}`}
          actionLabel="Save"
          busyLabel="Saving…"
          onSubmit={(v) => api.updateView(library.id, current.id, { name: v.name!.trim() }).then(onRenamed)}
          fields={<TextField name="name" label="Name" required maxLength={60} defaultValue={current.name} validate={nameCheck(library.views.filter((x) => x.id !== current.id).map((x) => x.name), 'view', true, 60)} autoFocus />}
        />
      ) : null}
      {doing === 'delete' && current ? (
        <Dialog open danger onClose={() => setDoing(undefined)} eyebrow="View" heading={`Delete ${current.name}?`} actionLabel="Delete" busyLabel="Deleting…" onSubmit={() => api.deleteView(library.id, current.id).then(onDeleted)}>
          <p>It leaves the views menu for everyone. No documents are touched.</p>
        </Dialog>
      ) : null}
    </>
  );
}
