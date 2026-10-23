import { LitElement, html, nothing } from 'lit';
import type { DialogSubmit, FieldCheck, ListItem, TreeItem } from '@augur/ui-kit';
import type { FolioApi, Folder, Library, OpenLibrary, Place } from './api.js';

type Dialog = 'new-library' | 'edit-library' | 'archive-library' | 'new-folder' | 'rename-folder' | 'remove-folder';

/** The folders inside `parent` (or at the top), as tree rows with theirs inside them. */
export const folderTree = (folders: readonly Folder[], parent?: string): TreeItem[] =>
  folders
    .filter((f) => f.parent === parent)
    .map((f) => {
      const children = folderTree(folders, f.id);
      return { id: f.id, label: f.name, icon: 'folder', ...(children.length ? { children } : {}) };
    });

/** From the top of the library down to `id`. */
export const folderTrail = (folders: readonly Folder[], id: string | undefined): Folder[] => {
  const trail: Folder[] = [];
  for (let at = folders.find((f) => f.id === id); at; at = folders.find((f) => f.id === at!.parent)) trail.unshift(at);
  return trail;
};

const nameCheck =
  (taken: readonly string[], what: string, slashes = true) =>
  (value: string): FieldCheck | null => {
    const name = value.trim();
    if (!name) return { state: 'error', message: `Give the ${what} a name.` };
    if (name.length > 80) return { state: 'error', message: 'Keep it to 80 characters.' };
    if (!slashes && /[/\\]/.test(name)) return { state: 'error', message: 'A folder’s name can’t have a slash in it.' };
    if (taken.some((t) => t.toLocaleLowerCase() === name.toLocaleLowerCase())) return { state: 'error', message: `There’s already a ${what} called ${name} here.` };
    return null;
  };

/**
 * Folio inside the shell's top bar: everything below it is Folio's own layout.
 * A side rail with the floor's libraries and the open library's folders, and a
 * main area with where you are, what you can do there, and what's inside.
 *
 * @fires folio-place - detail `{ library?, folder? }`, when the person moves somewhere else in Folio
 */
export class FolioApp extends LitElement {
  static override properties = {
    api: { attribute: false },
    floorName: { type: String, attribute: 'floor-name' },
    floorKind: { type: String, attribute: 'floor-kind' },
    place: { attribute: false },
    libraries: { state: true },
    canCreate: { state: true },
    open: { state: true },
    folder: { state: true },
    loading: { state: true },
    opening: { state: true },
    error: { state: true },
    dialog: { state: true },
    target: { state: true },
  };

  declare api: FolioApi;
  declare floorName: string;
  declare floorKind: 'personal' | 'team' | 'org';
  /** Where to start, from the path the shell mounted Folio at. */
  declare place: Place;
  declare libraries: Library[];
  declare canCreate: boolean;
  declare open: OpenLibrary | undefined;
  declare folder: string | undefined;
  declare loading: boolean;
  declare opening: boolean;
  declare error: string;
  declare dialog: Dialog | undefined;
  /** The folder a folder dialog is about. */
  declare target: Folder | undefined;

  constructor() {
    super();
    this.floorName = '';
    this.floorKind = 'team';
    this.place = { adding: false };
    this.libraries = [];
    this.canCreate = false;
    this.loading = true;
    this.opening = false;
    this.error = '';
  }

  override createRenderRoot() {
    return this;
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has('api') && this.api) void this.load();
  }

  async load() {
    this.loading = true;
    this.error = '';
    try {
      const { libraries, can } = await this.api.libraries();
      this.libraries = libraries;
      this.canCreate = can.create;
      const start = this.open?.id ?? this.place.library ?? libraries[0]?.id;
      if (this.place.adding && can.create) this.dialog = 'new-library';
      if (start && libraries.some((l) => l.id === start)) await this.openLibrary(start, this.open ? this.folder : this.place.folder, false);
      else this.open = undefined;
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.loading = false;
    }
  }

  private async openLibrary(id: string, folder?: string, tell = true) {
    this.opening = true;
    try {
      this.open = await this.api.library(id);
      this.folder = folder && this.open.folders.some((f) => f.id === folder) ? folder : undefined;
      if (tell) this.tell();
    } catch (err) {
      this.error = (err as Error).message;
    } finally {
      this.opening = false;
    }
  }

  private goToFolder(folder: string | undefined) {
    this.folder = folder;
    this.tell();
  }

  private tell() {
    this.dispatchEvent(new CustomEvent('folio-place', { detail: { library: this.open?.id, folder: this.folder }, bubbles: true }));
  }

  /** May the person rename or remove this folder: whoever made it, or a lead. */
  private mayChange(folder: Folder) {
    return Boolean(this.open?.can.manage || folder.createdBy === this.userId);
  }

  /** Set by the entry: who is signed in, so folders they made offer Rename and Remove. */
  userId = '';

  private submitNewLibrary: DialogSubmit = async (values) => {
    const made = await this.api.createLibrary(values.name.trim(), values.description?.trim() || undefined);
    this.libraries = [...this.libraries, made].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    await this.openLibrary(made.id);
  };

  private submitEditLibrary: DialogSubmit = async (values) => {
    const open = this.open!;
    const changed = await this.api.updateLibrary(open.id, { name: values.name.trim(), description: values.description?.trim() ?? '' });
    this.libraries = this.libraries.map((l) => (l.id === changed.id ? changed : l));
    this.open = { ...open, ...changed };
  };

  private submitArchive: DialogSubmit = async () => {
    await this.api.archiveLibrary(this.open!.id);
    this.libraries = this.libraries.filter((l) => l.id !== this.open!.id);
    this.open = undefined;
    this.folder = undefined;
    if (this.libraries[0]) await this.openLibrary(this.libraries[0].id);
    else this.tell();
  };

  private submitNewFolder: DialogSubmit = async (values) => {
    const open = this.open!;
    const made = await this.api.createFolder(open.id, values.name.trim(), this.folder);
    this.open = { ...open, folders: [...open.folders, made].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })) };
  };

  private submitRenameFolder: DialogSubmit = async (values) => {
    const open = this.open!;
    const renamed = await this.api.renameFolder(open.id, this.target!.id, values.name.trim());
    this.open = { ...open, folders: open.folders.map((f) => (f.id === renamed.id ? renamed : f)) };
  };

  private submitRemoveFolder: DialogSubmit = async () => {
    const open = this.open!;
    await this.api.deleteFolder(open.id, this.target!.id);
    this.open = { ...open, folders: open.folders.filter((f) => f.id !== this.target!.id) };
  };

  private onFolderAction(e: CustomEvent<{ item: ListItem; action: { id: string } }>) {
    this.target = this.open?.folders.find((f) => f.id === e.detail.item.id);
    this.dialog = e.detail.action.id === 'rename' ? 'rename-folder' : 'remove-folder';
  }

  /** "Your libraries" on your own floor, "Libraries on Finance" on a team's. */
  private get shelfName() {
    return this.floorKind === 'personal' ? 'Your libraries' : this.floorName ? `Libraries on ${this.floorName}` : 'Libraries';
  }

  private rail() {
    const open = this.open;
    return html`<nav class="folio-rail" aria-label="Libraries and folders">
      <ui-tree
        label="Libraries"
        heading=${this.shelfName}
        .items=${this.libraries.map((l): TreeItem => ({ id: l.id, label: l.name, icon: 'library' }))}
        selected=${open?.id ?? ''}
        @ui-select=${(e: CustomEvent<{ item: TreeItem }>) => void this.openLibrary(e.detail.item.id)}
      ></ui-tree>
      ${this.canCreate ? html`<div class="folio-rail-act"><ui-button kind="ghost" size="sm" @click=${() => (this.dialog = 'new-library')}>New library</ui-button></div>` : nothing}
      ${open && open.folders.length
        ? html`<ui-tree
            label=${`Folders in ${open.name}`}
            heading="Folders"
            .items=${folderTree(open.folders)}
            selected=${this.folder ?? ''}
            @ui-select=${(e: CustomEvent<{ item: TreeItem }>) => this.goToFolder(e.detail.item.id)}
          ></ui-tree>`
        : nothing}
    </nav>`;
  }

  private main() {
    if (this.loading) return html`<ui-state kind="loading" heading="Opening your libraries…"></ui-state>`;
    if (this.error)
      return html`<ui-state kind="error" heading="Couldn’t open Folio" body=${this.error} action="Try again" @ui-action=${() => void this.load()}></ui-state>`;
    const open = this.open;
    if (!open)
      return this.canCreate
        ? html`<ui-state kind="empty" heading="No libraries here yet" body="A library keeps documents together, with folders inside it." action="New library"
            @ui-action=${() => (this.dialog = 'new-library')}></ui-state>`
        : html`<ui-state kind="empty" heading="No libraries here yet" body="A lead on this floor can start one."></ui-state>`;
    const trail = folderTrail(open.folders, this.folder);
    const here = trail.at(-1);
    const inside: ListItem[] = open.folders
      .filter((f) => f.parent === this.folder)
      .map((f) => ({
        id: f.id,
        title: f.name,
        icon: 'folder',
        meta: String(open.folders.filter((c) => c.parent === f.id).length || ''),
        ...(this.mayChange(f) ? { actions: [{ id: 'rename', label: 'Rename' }, { id: 'remove', label: 'Remove' }] } : {}),
      }));
    return html`<div class="folio-main-inner" aria-busy=${this.opening ? 'true' : 'false'}>
      ${here
        ? html`<ol class="folio-trail" aria-label="Where you are">
            <li><button class="folio-crumb" @click=${() => this.goToFolder(undefined)}>${open.name}</button></li>
            ${trail.map(
              (f, i) => html`<li><span aria-hidden="true">/</span><button class="folio-crumb" aria-current=${i === trail.length - 1 ? 'page' : nothing} @click=${() => this.goToFolder(f.id)}>${f.name}</button></li>`,
            )}
          </ol>`
        : nothing}
      <div class="folio-head">
        <ui-heading eyebrow=${here ? (trail.at(-2)?.name ?? open.name) : this.shelfName} heading=${here?.name ?? open.name} summary=${here ? '' : open.description}></ui-heading>
        <div class="folio-actions">
          ${open.can.addFolders ? html`<ui-button kind="secondary" size="sm" @click=${() => (this.dialog = 'new-folder')}>New folder</ui-button>` : nothing}
          ${open.can.manage && !here
            ? html`<ui-button kind="ghost" size="sm" @click=${() => (this.dialog = 'edit-library')}>Rename</ui-button>
                <ui-button kind="ghost" size="sm" @click=${() => (this.dialog = 'archive-library')}>Archive</ui-button>`
            : nothing}
        </div>
      </div>
      <ui-surface>
        <ui-list
          label=${`In ${here?.name ?? open.name}`}
          density="compact"
          .noun=${['folder', 'folders']}
          .items=${inside}
          empty=${here ? 'This folder is empty.' : 'This library is empty.'}
          @ui-open=${(e: CustomEvent<{ item: ListItem }>) => this.goToFolder(e.detail.item.id)}
          @ui-action=${this.onFolderAction}
        ></ui-list>
      </ui-surface>
    </div>`;
  }

  private dialogs() {
    const open = this.open;
    const close = () => {
      this.dialog = undefined;
      this.target = undefined;
    };
    const siblings = (except?: string) => (open?.folders ?? []).filter((f) => f.parent === (this.target ? this.target.parent : this.folder) && f.id !== except).map((f) => f.name);
    switch (this.dialog) {
      case 'new-library':
        return html`<ui-dialog open eyebrow=${this.floorName || 'Folio'} heading="New library" summary=${this.floorKind === 'personal' ? 'Only you can see it.' : 'Everyone on this floor can see it and add folders; its leads look after it.'}
          action-label="Make it" busy-label="Making…" .submit=${this.submitNewLibrary} @ui-close=${close}>
          <ui-text-field slot="fields" name="name" label="Name" required maxlength="80" .validate=${nameCheck(this.libraries.map((l) => l.name), 'library')}></ui-text-field>
          <ui-text-field slot="fields" name="description" label="What it’s for" optional multiline maxlength="500"></ui-text-field>
        </ui-dialog>`;
      case 'edit-library':
        return open
          ? html`<ui-dialog open eyebrow="Library" heading=${`Rename ${open.name}`} action-label="Save" busy-label="Saving…" .submit=${this.submitEditLibrary} @ui-close=${close}>
              <ui-text-field slot="fields" name="name" label="Name" required maxlength="80" .value=${open.name}
                .validate=${nameCheck(this.libraries.filter((l) => l.id !== open.id).map((l) => l.name), 'library')}></ui-text-field>
              <ui-text-field slot="fields" name="description" label="What it’s for" optional multiline maxlength="500" .value=${open.description}></ui-text-field>
            </ui-dialog>`
          : nothing;
      case 'archive-library':
        return open
          ? html`<ui-dialog open danger eyebrow="Library" heading=${`Archive ${open.name}?`} action-label="Archive" busy-label="Archiving…" .submit=${this.submitArchive} @ui-close=${close}>
              <p>It leaves this floor’s list. Nothing in it is deleted.</p>
            </ui-dialog>`
          : nothing;
      case 'new-folder':
        return open
          ? html`<ui-dialog open eyebrow=${folderTrail(open.folders, this.folder).at(-1)?.name ?? open.name} heading="New folder" action-label="Make it" busy-label="Making…"
              .submit=${this.submitNewFolder} @ui-close=${close}>
              <ui-text-field slot="fields" name="name" label="Name" required maxlength="80" .validate=${nameCheck(siblings(), 'folder', false)}></ui-text-field>
            </ui-dialog>`
          : nothing;
      case 'rename-folder':
        return this.target
          ? html`<ui-dialog open eyebrow="Folder" heading=${`Rename ${this.target.name}`} action-label="Save" busy-label="Saving…" .submit=${this.submitRenameFolder} @ui-close=${close}>
              <ui-text-field slot="fields" name="name" label="Name" required maxlength="80" .value=${this.target.name} .validate=${nameCheck(siblings(this.target.id), 'folder', false)}></ui-text-field>
            </ui-dialog>`
          : nothing;
      case 'remove-folder':
        return this.target
          ? html`<ui-dialog open danger eyebrow="Folder" heading=${`Remove ${this.target.name}?`} action-label="Remove" busy-label="Removing…" .submit=${this.submitRemoveFolder} @ui-close=${close}>
              <p>Only an empty folder can be removed.</p>
            </ui-dialog>`
          : nothing;
      default:
        return nothing;
    }
  }

  override render() {
    return html`<style>
        /* Folio's own ground: the shell's water stays outside the app. */
        folio-app { display: grid; grid-template-columns: minmax(220px, 280px) 1fr; min-height: 100%; background: var(--slate); }
        folio-app .folio-rail { display: flex; flex-direction: column; gap: var(--space-5); padding: var(--space-6) var(--space-3); border-right: 1px solid var(--hairline); overflow-y: auto; }
        folio-app .folio-rail-act { padding: 0 var(--space-2); }
        folio-app .folio-main { min-width: 0; padding: var(--space-6) var(--edge); }
        folio-app .folio-main-inner { max-width: var(--measure-wide); display: flex; flex-direction: column; gap: var(--space-5); }
        folio-app .folio-main-inner[aria-busy='true'] { opacity: 0.6; }
        folio-app .folio-trail { display: flex; flex-wrap: wrap; gap: var(--space-2); margin: 0; padding: 0; list-style: none; font-size: var(--type-small); color: var(--ink-muted); }
        folio-app .folio-trail li { display: flex; gap: var(--space-2); }
        folio-app .folio-crumb { all: unset; cursor: pointer; border-radius: var(--radius-key); }
        folio-app .folio-crumb:hover { color: var(--ink); text-decoration: underline; }
        folio-app .folio-crumb:focus-visible { outline: 1.5px solid var(--focus); outline-offset: 2px; }
        folio-app .folio-crumb[aria-current] { color: var(--ink); }
        folio-app .folio-head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap; }
        folio-app .folio-actions { display: flex; gap: var(--space-2); }
      </style>
      ${this.rail()}
      <main class="folio-main">${this.main()}</main>
      ${this.dialogs()}`;
  }
}

if (!customElements.get('folio-app')) customElements.define('folio-app', FolioApp);

declare global {
  interface HTMLElementTagNameMap {
    'folio-app': FolioApp;
  }
}
