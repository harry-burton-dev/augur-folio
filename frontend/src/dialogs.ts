import { CONTENT_LIFECYCLE } from '@augur/records';
import type { RemoteNode } from '@augur/mfe-sdk/sdk3';
import type { ContentState, FolderLevel, GrantView, LevelInfo, Level, PeopleAnswer } from '../../service/src/api-types.js';
import { levelName } from './library.js';
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
  | { kind: 'share'; document: string; title: string; grants: GrantView[]; found?: PeopleAnswer; chosen: Principal[]; error?: string };

export interface DialogOn {
  close: () => void;
  newFolder: (values: { name: string; level?: string; description?: string }) => void;
  move: (to: ContentState, note?: string) => void;
  /** Shares with whoever is chosen now: the picker's choices reach the app as they change. */
  share: (level: Level) => void;
  unshare: (principal: string) => void;
  query: (q: string) => void;
  choose: (chosen: Principal[]) => void;
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
