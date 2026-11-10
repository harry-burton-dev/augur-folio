import { CONTENT_LIFECYCLE } from '@augur/records';
import type { RemoteNode } from '@augur/mfe-sdk/sdk3';
import type { ContentState, FolderLevel, GrantView, LandingPlace, LevelInfo, Level, LinkKind, PeopleAnswer, PlacementsAnswer, RecordKind } from '../../service/src/api-types.js';
import { floorName, levelName, statesLine } from './library.js';
import { quill } from './screen.js';

/**
 * The app's dialogs, drawn into the screen as `quill-dialog`s: the shell's Dialog holds the fields
 * (`slot: 'fields'`), sends their values by name on submit and stays busy until the app closes it or
 * says why not (`error`).
 */

/** A person or team as the people picker shows them. */
export interface Principal {
  kind: 'person' | 'team';
  id: string;
  name: string;
  detail?: string;
}

export type Dialog =
  | { kind: 'folder'; parent?: string; levels: FolderLevel[]; error?: string }
  | { kind: 'add'; into: { folder: string; name: string } | { document: string; title: string }; error?: string; busy?: boolean }
  | { kind: 'move'; document: string; version: number; options: { to: ContentState; allowed: boolean; why?: string }[]; error?: string }
  | { kind: 'share'; document: string; title: string; grants: GrantView[]; found?: PeopleAnswer; chosen: Principal[]; error?: string }
  /** `target` is a target's key (`targetKey`); `filter` the states ticked. */
  | { kind: 'publish'; record: { kind: RecordKind; id: string }; title: string; answer: PlacementsAnswer; target?: string; filter: ContentState[]; error?: string }
  | { kind: 'land'; placement: string; title: string; places: LandingPlace[]; current?: string; error?: string }
  /** `found` is what Find answered for `query`; `relation` and `to` what's chosen so far. */
  | { kind: 'link'; document: string; title: string; kinds: LinkKind[]; relation: string; query?: string; found?: { id: string; title: string; detail?: string }[]; to?: string; error?: string };

/** Which floor a publish target goes to, and from which placement when it goes on up. */
export const targetKey = (t: { to: { id: string }; via?: string }) => `${t.to.id}${t.via ? `|${t.via}` : ''}`;

export interface DialogOn {
  close: () => void;
  newFolder: (values: { name: string; level?: string; description?: string }) => void;
  move: (to: ContentState, note?: string) => void;
  /** Shares with whoever is chosen now: the picker's choices reach the app as they change. */
  share: (level: Level) => void;
  unshare: (principal: string) => void;
  query: (q: string) => void;
  choose: (chosen: Principal[]) => void;
  publish: (note?: string) => void;
  target: (key: string) => void;
  filter: (states: ContentState[]) => void;
  withdraw: (placement: string) => void;
  land: (folder?: string) => void;
  link: () => void;
  linkRelation: (relation: string) => void;
  linkQuery: (q: string) => void;
  linkTo: (document: string) => void;
}

const field = (node: ReturnType<typeof quill>) => ({ ...node, props: { ...node.props, slot: 'fields' } });

const LEVEL_OPTIONS = [
  { value: 'read', label: 'Read it', detail: 'Open and download it, nothing else.' },
  { value: 'edit', label: 'Change it', detail: 'Add versions and move them along, short of issuing.' },
  { value: 'manage', label: 'Manage it', detail: 'Issue, retire and share it too.' },
];

export const dialogFor = (dialog: Dialog | undefined, levels: readonly LevelInfo[], on: DialogOn): RemoteNode => {
  if (!dialog) return null;
  const common = { open: true, onClose: on.close, ...(dialog.error ? { error: dialog.error } : {}) };
  switch (dialog.kind) {
    case 'folder': {
      const first = dialog.levels[0]!;
      return quill(
        'quill-dialog',
        {
          ...common,
          heading: `New ${levelName(levels, first).toLowerCase()}`,
          actionLabel: 'Make it',
          size: 'decision',
          onSubmit: (values: Record<string, string>) => on.newFolder({ name: values.name ?? '', ...(values.level ? { level: values.level } : {}), ...(values.description ? { description: values.description } : {}) }),
        },
        [
          field(quill('quill-text-field', { label: 'Name', name: 'name', required: true, maxLength: 80 })),
          dialog.levels.length > 1
            ? field(quill('quill-choice', { label: 'What it is', name: 'level', value: first, options: dialog.levels.map((l) => ({ value: l, label: levelName(levels, l) })) }))
            : null,
          field(quill('quill-text-field', { label: 'What it’s for', name: 'description', optional: true, multiline: true, rows: 2, maxLength: 500 })),
        ],
      );
    }
    case 'add': {
      const toFolder = 'folder' in dialog.into;
      return quill(
        'quill-dialog',
        {
          ...common,
          heading: toFolder ? `Add to “${(dialog.into as { name: string }).name}”` : `A new version of “${(dialog.into as { title: string }).title}”`,
          summary: toFolder
            ? 'Each file becomes a document here, kept exactly as it is. You can also drop files on the page.'
            : 'The file becomes the next version, In progress. The versions before it stay as they are.',
          cancelLabel: 'Done',
          size: 'glance',
          ...(dialog.busy ? { busy: true, busyLabel: 'Adding' } : {}),
        },
        [quill('quill-file-button', { label: toFolder ? 'Choose files' : 'Choose the file', kind: 'primary', icon: 'upload', multiple: toFolder })],
      );
    }
    case 'move': {
      const allowed = dialog.options.find((o) => o.allowed);
      return quill(
        'quill-dialog',
        {
          ...common,
          heading: `Move version ${dialog.version} to…`,
          actionLabel: 'Move it',
          size: 'decision',
          onSubmit: (values: Record<string, string>) => on.move((values.to ?? allowed?.to) as ContentState, values.note || undefined),
        },
        [
          field(
            quill('quill-choice', {
              label: 'Where it goes',
              name: 'to',
              ...(allowed ? { value: allowed.to } : {}),
              options: dialog.options.map((o) => ({
                value: o.to,
                label: CONTENT_LIFECYCLE.get(o.to).name,
                detail: CONTENT_LIFECYCLE.get(o.to).meaning,
                ...(o.allowed ? {} : { disabled: true, reason: o.why ?? 'You can’t make that move.' }),
              })),
            }),
          ),
          field(quill('quill-text-field', { label: 'Note', name: 'note', optional: true, multiline: true, rows: 2, maxLength: 500, hint: 'Kept with the move, for whoever reads its history.' })),
        ],
      );
    }
    case 'publish': {
      const { answer } = dialog;
      const target = answer.targets.find((t) => targetKey(t) === dialog.target);
      const most = target?.most;
      const live = answer.placements.filter((p) => !p.ended);
      return quill(
        'quill-dialog',
        {
          ...common,
          heading: `Publish “${dialog.title}” up`,
          summary: 'The floor you choose sees it, live, in the states you tick: what changes here shows there. Nothing is copied.',
          actionLabel: 'Publish up',
          size: 'read',
          onSubmit: (values: Record<string, string>) => on.publish(values.note || undefined),
        },
        [
          field(
            quill('quill-details', {
              items: [
                { label: 'Kept on', value: answer.own.name },
                { label: 'Owned by', value: answer.owner.name, note: 'The highest floor it has reached owns it.' },
              ],
            }),
          ),
          field(
            quill('quill-choice', {
              label: 'Up to',
              name: 'to',
              ...(dialog.target ? { value: dialog.target } : {}),
              options: answer.targets.map((t) => ({
                value: targetKey(t),
                label: t.to.name,
                ...(t.via ? { detail: `On up from ${floorName(t.from)}, which was shown ${statesLine(t.most ?? []).toLowerCase()}` } : {}),
                ...(t.why ? { disabled: true, reason: t.why } : {}),
              })),
              onChange: on.target,
            }),
          ),
          field(
            quill('quill-checkbox-group', {
              label: 'They see',
              name: 'filter',
              value: dialog.filter,
              hint: 'Complete and Issued at first: what’s finished.',
              options: CONTENT_LIFECYCLE.states.map((st) => ({
                value: st.id,
                label: st.name,
                detail: st.meaning,
                ...(most && !most.includes(st.id) ? { disabled: true, reason: 'A floor can’t show more than it was shown.' } : {}),
              })),
              onChange: (values: string[]) => on.filter(values as ContentState[]),
            }),
          ),
          field(quill('quill-text-field', { label: 'Note', name: 'note', optional: true, multiline: true, rows: 2, maxLength: 500, hint: 'Sent to the floor with it.' })),
          live.length
            ? quill('quill-list', {
                label: 'Published up to',
                noun: ['floor', 'floors'],
                density: 'compact',
                items: live.map((p) => ({
                  id: p.id,
                  title: p.to.name,
                  detail: `Shows ${statesLine(p.filter).toLowerCase()}${p.landed ? ` · in ${p.landed.name}` : ''}`,
                  ...(p.can.withdraw ? { actions: [{ id: 'withdraw', label: 'Take it back' }] } : {}),
                })),
                onAction: ({ item }: { item: string; action: string }) => on.withdraw(item),
              })
            : null,
        ],
      );
    }
    case 'link': {
      const found = (dialog.found ?? []).filter((d) => d.id !== dialog.document);
      return quill(
        'quill-dialog',
        {
          ...common,
          heading: `Link “${dialog.title}” to…`,
          summary: 'Another document on this floor. Both show the link, each read its own way.',
          actionLabel: 'Link them',
          size: 'decision',
          onSubmit: () => on.link(),
        },
        [
          field(
            quill('quill-choice', {
              label: 'How',
              name: 'relation',
              value: dialog.relation,
              options: dialog.kinds.map((k) => ({ value: k.id, label: k.name, detail: `Read back as “${k.inverse}”`, ...(k.available ? {} : { disabled: true, reason: k.why ?? 'It can’t be made here.' }) })),
              onChange: on.linkRelation,
            }),
          ),
          field(quill('quill-text-field', { label: 'Find the document', name: 'q', type: 'search', placeholder: 'Words in its title', ...(dialog.query ? { value: dialog.query } : {}), onCommit: on.linkQuery, onChange: on.linkQuery })),
          dialog.query
            ? field(
                found.length
                  ? quill('quill-choice', { label: 'Which', name: 'to', ...(dialog.to ? { value: dialog.to } : {}), options: found.map((d) => ({ value: d.id, label: d.title, ...(d.detail ? { detail: d.detail } : {}) })), onChange: on.linkTo })
                  : quill('quill-state', { kind: 'empty', heading: `No document here has “${dialog.query}” in its title.`, size: 'line' }),
              )
            : null,
        ],
      );
    }
    case 'land':
      return quill(
        'quill-dialog',
        {
          ...common,
          heading: `Give “${dialog.title}” a place`,
          summary: 'Where it sits in this floor’s library. It is still kept, and changed, on the floor that published it.',
          actionLabel: 'Put it there',
          size: 'decision',
          onSubmit: (values: Record<string, string>) => on.land(values.folder || undefined),
        },
        [
          field(
            quill('quill-choice', {
              label: 'In',
              name: 'folder',
              value: dialog.current ?? dialog.places[0]?.id ?? '',
              options: [...dialog.places.map((pl) => ({ value: pl.id, label: pl.label, detail: levelName(levels, pl.level) })), { value: '', label: 'Leave it under From below' }],
            }),
          ),
        ],
      );
    case 'share':
      return quill(
        'quill-dialog',
        {
          ...common,
          heading: `Share “${dialog.title}”`,
          summary: 'Let people or teams on other floors open it. Nothing else on this floor opens for them.',
          actionLabel: 'Share',
          size: 'read',
          onSubmit: (values: Record<string, string>) => on.share((values.level as Level) ?? 'read'),
        },
        [
          field(
            quill('quill-people-picker', {
              label: 'With',
              kinds: 'both',
              multiple: true,
              placeholder: 'A name or a team',
              value: dialog.chosen,
              ...(dialog.found ? { found: { query: dialog.found.query, items: dialog.found.items, ...(dialog.found.error ? { error: dialog.found.error } : {}) } } : {}),
              onQuery: on.query,
              onChange: on.choose,
            }),
          ),
          field(quill('quill-choice', { label: 'They can', name: 'level', value: 'read', options: LEVEL_OPTIONS })),
          quill('quill-list', {
            label: 'Shared with now',
            noun: ['person or team', 'people and teams'],
            density: 'compact',
            items: dialog.grants
              .filter((g) => g.kind === 'document')
              .map((g) => ({ id: g.principal, title: g.name ?? g.principal, detail: `Can ${g.level}`, actions: [{ id: 'unshare', label: 'Stop sharing' }] })),
            empty: 'Not shared with anyone yet.',
            onAction: ({ item }: { item: string; action: string }) => on.unshare(item),
          }),
        ],
      );
  }
};
