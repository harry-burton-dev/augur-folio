import { LitElement, html } from 'lit';
import { ago, type ListItem, type SelectOption } from '@augur/ui-kit';
import { fileTypeOf, type FolioApi, type FolioDocument, type Library } from './api.js';

/** A document as the picker lists it: where it is, and which version is the person's to pick. */
type Pickable = FolioDocument & { libraryName: string; audienceOnly?: boolean };

/** What the picker answers with: a DocumentRef for Folio's document. */
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

/**
 * Folio answering `document.pick` for another app: find a document by what's
 * typed (its title, tags or words in it), or look through a library on this
 * floor or shared with the person, newest first. Only the kinds of file the
 * asking app takes are offered.
 *
 * @fires folio-picked - detail `{ document: Picked }`
 * @fires folio-cancel - the person closed it without picking
 */
export class FolioPicker extends LitElement {
  static override properties = {
    api: { attribute: false },
    purpose: { type: String },
    accept: { attribute: false },
    libraries: { state: true },
    library: { state: true },
    query: { state: true },
    documents: { state: true },
    loading: { state: true },
    failure: { state: true },
  };

  declare api: FolioApi;
  /** What the asking app says it's for: "Attach a policy". */
  declare purpose: string;
  /** Media types the asking app takes; none for any. */
  declare accept: string[];
  declare libraries: (Library & { shared?: boolean })[];
  declare library: string;
  declare query: string;
  declare documents: Pickable[];
  declare loading: boolean;
  declare failure: string;

  private timer?: ReturnType<typeof setTimeout>;
  private asked = 0;

  constructor() {
    super();
    this.purpose = '';
    this.accept = [];
    this.libraries = [];
    this.library = '';
    this.query = '';
    this.documents = [];
    this.loading = true;
    this.failure = '';
  }

  override createRenderRoot() {
    return this;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.timer);
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has('api') && this.api) void this.start();
  }

  private async start() {
    try {
      const [{ libraries }, shared] = await Promise.all([this.api.libraries(), this.api.shared()]);
      this.libraries = [...libraries, ...shared.libraries.map((l) => ({ ...l, shared: true }))];
      this.library = this.libraries[0]?.id ?? '';
      await this.list();
    } catch (err) {
      this.failure = (err as Error).message;
      this.loading = false;
    }
  }

  /** What's typed, or else the chosen library's documents, newest first. */
  private async list() {
    const asked = ++this.asked;
    this.loading = true;
    this.failure = '';
    try {
      const q = this.query.trim();
      const documents: Pickable[] = q
        ? (await this.api.find(q)).documents
        : this.library
          ? (await this.api.documents(this.library, { below: true, sort: 'updated', limit: 50 })).documents.map((d) => ({ ...d, libraryName: this.libraries.find((l) => l.id === this.library)?.name ?? '' }))
          : [];
      if (asked === this.asked) this.documents = documents;
    } catch (err) {
      if (asked === this.asked) this.failure = (err as Error).message;
    } finally {
      if (asked === this.asked) this.loading = false;
    }
  }

  private search(q: string) {
    this.query = q;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.list(), 200);
  }

  private emit(name: string, detail: object = {}) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
  }

  override render() {
    const takes = (d: Pickable) => !this.accept.length || this.accept.includes(d.latest.mediaType);
    const offered = this.documents.filter(takes);
    const rows: ListItem[] = offered.map((d) => ({
      id: d.id,
      title: d.title,
      detail: [`In ${d.libraryName}`, `Version ${pickedOf(d).version}`, fileTypeOf(d.latest.filename)?.word].filter(Boolean).join(' · '),
      meta: ago(d.updatedAt),
      icon: d.state === 'published' ? 'publish' : 'document',
    }));
    const options: SelectOption[] = this.libraries.map((l) => ({ value: l.id, label: l.shared ? `${l.name} (shared with you)` : l.name }));
    const hidden = this.documents.length - offered.length;
    const empty = this.query.trim()
      ? 'Nothing you can read matches that.'
      : this.libraries.length
        ? 'There’s nothing in this collection yet.'
        : 'There are no collections on this floor yet. Type to find a document anywhere you can read.';
    return html`<style>
        folio-picker { display: flex; flex-direction: column; gap: var(--space-5); min-width: min(40rem, 100%); }
        folio-picker .folio-picker-find { display: flex; gap: var(--space-4); flex-wrap: wrap; align-items: flex-end; }
        folio-picker .folio-picker-find ui-text-field { flex: 2; min-width: 14rem; }
        folio-picker .folio-picker-find ui-select { flex: 1; min-width: 12rem; }
      </style>
      <ui-heading eyebrow="Pick from Artifacts" heading=${this.purpose || 'Pick a document'} summary="Find one by its title, a tag or words in it, or look through a collection."></ui-heading>
      <div class="folio-picker-find">
        <ui-text-field label="Find" placeholder="Title, tag or words in it" .value=${this.query} @ui-input=${(e: CustomEvent<{ value: string }>) => this.search(e.detail.value)}></ui-text-field>
        ${options.length && !this.query.trim()
          ? html`<ui-select label="Library" .options=${options} .value=${this.library}
              @ui-change=${(e: CustomEvent<{ value: string }>) => {
                this.library = e.detail.value;
                void this.list();
              }}></ui-select>`
          : ''}
      </div>
      <ui-list label="Documents to pick from" density="compact" .noun=${['document', 'documents']} .items=${rows} ?loading=${this.loading} error=${this.failure} empty=${empty}
        @ui-open=${(e: CustomEvent<{ item: ListItem }>) => {
          const doc = offered.find((d) => d.id === e.detail.item.id);
          if (doc) this.emit('folio-picked', { document: pickedOf(doc) });
        }}></ui-list>
      ${hidden > 0 ? html`<p class="folio-note">${hidden === 1 ? 'One other isn’t' : `${hidden} others aren’t`} the kind of file asked for.</p>` : ''}
      <div class="folio-actions"><ui-button kind="ghost" size="sm" @click=${() => this.emit('folio-cancel')}>Cancel</ui-button></div>`;
  }
}

if (!customElements.get('folio-picker')) customElements.define('folio-picker', FolioPicker);

declare global {
  interface HTMLElementTagNameMap {
    'folio-picker': FolioPicker;
  }
}
