import { LitElement, html, nothing } from 'lit';
import type { ListItem, SelectOption } from '@augur/ui-kit';
import type { FolioApi, RecordLink, RecordLinks, RecordView, RelationKind } from './api.js';
import { agoWords } from './folio-publish.js';

/** A record in another app, as a link keeps it. */
export interface LinkRef {
  app: string;
  kind: string;
  id: string;
  label?: string;
}
/** Asks the person to pick a thing in Data Atlas, or an intent in Mandate, in that app: nothing when they close it. */
export type PickRef = (app: 'atlas' | 'mandate') => Promise<LinkRef | undefined>;
/** Opens a thing in Data Atlas, or an intent in Mandate, in that app. */
export type OpenRef = (ref: LinkRef) => Promise<void>;

/** The app a link's other end is in, by name. */
const APP_NAMES: Record<string, string> = { atlas: 'Data Atlas', mandate: 'Mandate' };

/** Where a relation's other end lives: Artifacts' own records, a thing in Data Atlas, or an intent in Mandate. */
export const relationTarget = (relation: RelationKind['id']) => (relation === 'about' ? 'atlas' : relation === 'serves' ? 'mandate' : 'folio');

/** One of the library's own records, to link to. */
interface Linkable {
  id: string;
  kind: RecordView['kind'];
  name: string;
}

/** A link as a row: what it says, what it's to, and whether it can be opened. */
export const linkRow = (l: RecordLink, change: boolean): ListItem => {
  const end = l.to ?? l.from;
  const unavailable = end && 'unavailable' in end ? end.unavailable : undefined;
  const name = l.to ? (l.to.label ?? l.to.id) : l.from && 'name' in l.from ? l.from.name : 'Something';
  const where = l.to && l.to.app !== 'folio' ? `In ${APP_NAMES[l.to.app] ?? l.to.app}` : '';
  return {
    id: l.id,
    title: unavailable ? `${l.words}: ${unavailable}` : `${l.words} ${name}`,
    detail: [where, `Linked ${agoWords(l.at)}`].filter(Boolean).join(' · '),
    icon: l.to?.app === 'atlas' ? 'atlas' : l.to?.app === 'mandate' ? 'compass' : 'link',
    ...(change && l.to ? { actions: [{ id: 'unlink', label: 'Unlink' }] } : {}),
  };
};

/**
 * A record's relationships: what it links to (others in Artifacts, things in
 * Data Atlas, intents in Mandate) and what links to it, read back the other
 * way. Whoever may change the record adds and removes its links. A linked
 * record the person can't open stays in the list and says so; a kind of link
 * they can't make from here stays in the choice and says why.
 *
 * @fires folio-open-link - detail `{ link }`, to open the other end
 */
export class FolioLinks extends LitElement {
  static override properties = {
    api: { attribute: false },
    library: { type: String },
    record: { attribute: false },
    pickRef: { attribute: false },
    data: { state: true },
    failure: { state: true },
    linkable: { state: true },
    relation: { state: true },
    target: { state: true },
    busy: { state: true },
    note: { state: true },
  };

  declare api: FolioApi;
  declare library: string;
  declare record: { kind: RecordView['kind']; id: string; name: string } | undefined;
  /** Asks the person for a thing in Data Atlas or an intent in Mandate; without it, `about` and `serves` links can't be made here. */
  declare pickRef: PickRef | undefined;
  declare data: RecordLinks | undefined;
  declare failure: string;
  declare linkable: Linkable[];
  declare relation: RelationKind['id'];
  /** The library's record to link to, by id. */
  declare target: string;
  declare busy: boolean;
  declare note: string;

  constructor() {
    super();
    this.library = '';
    this.failure = '';
    this.linkable = [];
    this.relation = 'relates-to';
    this.target = '';
    this.busy = false;
    this.note = '';
  }

  override createRenderRoot() {
    return this;
  }

  /** The record whose links are loaded, so a new copy of the same record doesn't load them again. */
  private loadedFor = '';

  override willUpdate() {
    const key = this.api && this.library && this.record ? `${this.library}/${this.record.id}` : '';
    if (key && key !== this.loadedFor) {
      this.loadedFor = key;
      this.data = undefined;
      void this.load();
    }
  }

  async load() {
    this.failure = '';
    try {
      this.data = await this.api.links(this.library, this.record!.id);
      if (this.data.can.change) void this.loadLinkable();
    } catch (err) {
      this.failure = (err as Error).message;
    }
  }

  /** The library's folders and documents, to link to: everything but the record itself. */
  private async loadLinkable() {
    try {
      const [open, { documents }] = await Promise.all([this.api.library(this.library), this.api.documents(this.library, { below: true, limit: 200 })]);
      this.linkable = [
        ...(this.record!.id === this.library ? [] : [{ id: this.library, kind: 'library' as const, name: open.name }]),
        ...open.folders.map((f) => ({ id: f.id, kind: 'folder' as const, name: f.name })),
        ...documents.map((d) => ({ id: d.id, kind: 'document' as const, name: d.title })),
      ].filter((r) => r.id !== this.record!.id);
    } catch {
      this.linkable = [];
    }
  }

  private async add() {
    const relation = this.relation;
    const target = relationTarget(relation);
    let to: LinkRef;
    if (target === 'folio') to = { app: 'folio', kind: 'unit', id: `${this.library}/${this.target}` };
    else {
      try {
        const picked = await this.pickRef!(target);
        if (!picked) return;
        to = picked;
      } catch (err) {
        this.note = (err as Error).message;
        return;
      }
    }
    this.busy = true;
    try {
      const made = await this.api.link(this.library, this.record!.id, relation, to);
      this.note = `${this.record!.name} ${made.words.toLowerCase()} ${made.to?.label ?? 'it'} now.`;
      this.target = '';
      await this.load();
    } catch (err) {
      this.note = (err as Error).message;
    } finally {
      this.busy = false;
    }
  }

  private async unlink(id: string) {
    try {
      await this.api.unlink(this.library, this.record!.id, id);
      this.note = 'Unlinked.';
      await this.load();
    } catch (err) {
      this.note = (err as Error).message;
    }
  }

  private open(item: ListItem, list: readonly RecordLink[]) {
    const link = list.find((l) => l.id === item.id);
    const end = link?.to ?? link?.from;
    if (!link || !end || 'unavailable' in end) return;
    this.dispatchEvent(new CustomEvent('folio-open-link', { detail: { link }, bubbles: true }));
  }

  /** Why a kind of link can't be made from here, or nothing when it can. */
  private why(relation: RelationKind['id']) {
    const target = relationTarget(relation);
    if (target !== 'folio' && !this.pickRef) return `${APP_NAMES[target]} isn’t open to you from here.`;
    return '';
  }

  private form(data: RecordLinks) {
    if (!data.can.change) return html`<p class="folio-links-hint">Only whoever may change it can link it to something.</p>`;
    const kinds: SelectOption[] = data.kinds.map((k) => {
      const why = this.why(k.id);
      return { value: k.id, label: k.name, ...(why ? { disabled: true, detail: why } : {}) };
    });
    const toFolio = relationTarget(this.relation) === 'folio';
    const targets: SelectOption[] = this.linkable.map((r) => ({ value: r.id, label: r.name, detail: r.kind === 'library' ? 'The library' : r.kind === 'folder' ? 'Folder' : 'Document' }));
    const ready = toFolio ? Boolean(this.target) : !this.why(this.relation);
    return html`<section class="folio-links-form" aria-label="Link it">
      <ui-select label="Link it" .options=${kinds} .value=${this.relation}
        @ui-change=${(e: CustomEvent<{ value: string }>) => (this.relation = e.detail.value as RelationKind['id'])}></ui-select>
      ${toFolio
        ? html`<ui-select label="To" placeholder="Choose from this library" .options=${targets} .value=${this.target}
            hint=${targets.length ? 'Something in another library links here from there.' : 'There’s nothing else in this library yet.'}
            @ui-change=${(e: CustomEvent<{ value: string }>) => (this.target = e.detail.value)}></ui-select>`
        : nothing}
      <div class="folio-actions">
        <ui-button kind="secondary" size="sm" ?disabled=${!ready} reason=${toFolio ? 'Choose what it links to first.' : this.why(this.relation)}
          ?busy=${this.busy} busy-label="Linking…" @click=${() => void this.add()}>${toFolio ? 'Link' : `Choose in ${APP_NAMES[relationTarget(this.relation)]}`}</ui-button>
      </div>
    </section>`;
  }

  override render() {
    if (this.failure) return html`<ui-state kind="error" heading="Couldn’t see its links" body=${this.failure} action="Try again" @ui-action=${() => void this.load()}></ui-state>`;
    const data = this.data;
    if (!data) return html`<ui-state kind="loading" heading="Seeing what it links to"></ui-state>`;
    const rows = data.links.map((l) => linkRow(l, data.can.change));
    const back = data.back.map((l) => linkRow(l, false));
    return html`<style>
        folio-links { display: flex; flex-direction: column; gap: var(--space-4); }
        folio-links .folio-links-form { display: flex; flex-direction: column; gap: var(--space-3); }
        folio-links .folio-links-hint { margin: 0; font-size: var(--type-small); color: var(--ink-muted); }
      </style>
      ${rows.length || back.length
        ? html`${rows.length
            ? html`<ui-list label="What it links to" density="compact" .noun=${['link', 'links']} .items=${rows}
                @ui-open=${(e: CustomEvent<{ item: ListItem }>) => this.open(e.detail.item, data.links)}
                @ui-action=${(e: CustomEvent<{ item: ListItem }>) => void this.unlink(e.detail.item.id)}></ui-list>`
            : nothing}
          ${back.length
            ? html`<ui-list label="What links to it" density="compact" .noun=${['link', 'links']} .items=${back}
                @ui-open=${(e: CustomEvent<{ item: ListItem }>) => this.open(e.detail.item, data.back)}></ui-list>`
            : nothing}`
        : html`<p class="folio-links-hint">Nothing links to or from it yet. Links say what supersedes what, what answers what, and what it’s about.</p>`}
      ${this.form(data)}
      <p class="folio-note" role="status">${this.note}</p>`;
  }
}

if (!customElements.get('folio-links')) customElements.define('folio-links', FolioLinks);

declare global {
  interface HTMLElementTagNameMap {
    'folio-links': FolioLinks;
  }
}
