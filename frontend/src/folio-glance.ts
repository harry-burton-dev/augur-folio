import { LitElement, html, nothing } from 'lit';
import { ago, type Fact, type ListItem } from '@augur/ui-kit';
import type { Brief, FolioApi, HomeGlance } from './api.js';

/** How many documents the card names: it's a glance, not a list. */
const NAMED = 1;

/**
 * Folio's card on Home: how much has been published to the person since they
 * last looked, the newest of it, and for the floor's leads how many drafts are
 * waiting to publish. A document opens with `document.open`; the button opens
 * what's been published to them.
 *
 * @fires folio-open-document - detail `{ document: Brief }`
 * @fires folio-open-published - to see everything published to them
 */
export class FolioGlance extends LitElement {
  static override properties = {
    api: { attribute: false },
    glance: { state: true },
    failure: { state: true },
  };

  declare api: FolioApi;
  declare glance: HomeGlance | undefined;
  declare failure: string;

  constructor() {
    super();
    this.failure = '';
  }

  override createRenderRoot() {
    return this;
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has('api') && this.api) void this.load();
  }

  async load() {
    this.failure = '';
    try {
      this.glance = await this.api.home();
    } catch (err) {
      this.failure = (err as Error).message;
    }
  }

  private emit(name: string, detail: object = {}) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
  }

  override render() {
    if (this.failure) return html`<ui-state kind="error" heading="Couldn’t reach Folio" body=${this.failure} action="Try again" @ui-action=${() => void this.load()}></ui-state>`;
    const glance = this.glance;
    if (!glance) return html`<ui-facts loading count="2"></ui-facts>`;
    const { published, drafts } = glance;
    // Before they've ever looked, everything published to them is new.
    const facts: Fact[] = [{ value: published.new, label: 'New to you' }, ...(drafts ? [{ value: drafts.total, label: 'Drafts' }] : [])];
    // The newest of what's new; with nothing new, a lead's newest drafts.
    const named: (Brief & { draft?: boolean })[] = published.documents.length ? published.documents : (drafts?.documents ?? []).map((d) => ({ ...d, draft: true }));
    const rows: ListItem[] = named.slice(0, NAMED).map((d) => ({ id: d.id, title: d.title, detail: `${d.draft ? 'Draft in' : 'From'} ${d.libraryName}`, meta: ago(d.at), icon: d.draft ? 'document' : 'publish' }));
    return html`<style>
        folio-glance { display: flex; flex-direction: column; gap: var(--space-3); }
      </style>
      <ui-facts .items=${facts}></ui-facts>
      ${rows.length
        ? html`<ui-list label="Newest" density="compact" .bar=${false} .items=${rows}
            @ui-open=${(e: CustomEvent<{ item: ListItem }>) => this.emit('folio-open-document', { document: named.find((d) => d.id === e.detail.item.id) })}></ui-list>`
        : nothing}
      <div><ui-button kind="secondary" size="sm" @click=${() => this.emit('folio-open-published')}>Published to you</ui-button></div>`;
  }
}

if (!customElements.get('folio-glance')) customElements.define('folio-glance', FolioGlance);

declare global {
  interface HTMLElementTagNameMap {
    'folio-glance': FolioGlance;
  }
}
