import { LitElement, html, nothing } from 'lit';
import type { ListItem } from '@augur/ui-kit';
import type { FolioApi, Found } from './api.js';

/** A principal as the audience list shows it before it's saved: named from what the person picked. */
export interface Chosen {
  principal: string;
  name: string;
}

/**
 * Who something goes to: teams found by name (with the teams below them, or
 * just that team), or the whole org for whoever may publish there. Publishing
 * picks a version's audience with it, and a series the audience of its issues.
 * In a dialog's fields it answers as `name`, the principals joined by commas.
 *
 * @fires folio-change - detail `{ chosen }`, when the list changes
 */
export class FolioAudience extends LitElement {
  static override properties = {
    api: { attribute: false },
    name: { type: String, reflect: true },
    label: { type: String },
    empty: { type: String },
    org: { type: Boolean },
    chosen: { attribute: false },
    query: { state: true },
    found: { state: true },
    below: { state: true },
    note: { state: true },
  };

  declare api: FolioApi;
  declare name: string;
  declare label: string;
  /** What the list says while no one is in it. */
  declare empty: string;
  /** The whole org may be added: the person has the publisher role. */
  declare org: boolean;
  declare chosen: Chosen[];
  declare query: string;
  declare found: Found | undefined;
  /** A team found and added takes the teams below it too. */
  declare below: boolean;
  declare note: string;

  private searchTimer?: ReturnType<typeof setTimeout>;
  private asked = 0;

  constructor() {
    super();
    this.name = '';
    this.label = 'Who it goes to';
    this.empty = 'Add a team, or the whole org.';
    this.org = false;
    this.chosen = [];
    this.query = '';
    this.below = true;
    this.note = '';
  }

  override createRenderRoot() {
    return this;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this.searchTimer);
  }

  get value() {
    return this.chosen.map((c) => c.principal).join(',');
  }

  /** Any audience will do, none included; a dialog asks every field. */
  check() {
    return true;
  }

  private set(chosen: Chosen[]) {
    this.chosen = chosen;
    this.dispatchEvent(new CustomEvent('folio-change', { detail: { chosen }, bubbles: true }));
  }

  private search(q: string) {
    this.query = q;
    clearTimeout(this.searchTimer);
    if (!q.trim()) {
      this.found = undefined;
      return;
    }
    const asked = ++this.asked;
    this.searchTimer = setTimeout(async () => {
      try {
        const found = await this.api.people(q.trim());
        if (asked === this.asked) this.found = found;
      } catch (err) {
        if (asked === this.asked) this.note = (err as Error).message;
      }
    }, 200);
  }

  private add(principal: string, name: string) {
    const id = principal.slice(principal.indexOf(':') + 1);
    // One way in for each team: just it, or it and those below.
    this.set([...this.chosen.filter((c) => c.principal !== `team:${id}` && c.principal !== `tree:${id}`), { principal, name }]);
    this.query = '';
    this.found = undefined;
  }

  override render() {
    const chosen: ListItem[] = this.chosen.map((c) => ({ id: c.principal, title: c.name, icon: c.principal === 'org' ? 'org' : 'people', actions: [{ id: 'remove', label: 'Remove' }] }));
    const teams: ListItem[] = (this.found?.teams ?? []).map((t) => ({ id: t.id, title: t.name, detail: t.within.length ? `Team in ${t.within.join(' / ')}` : 'Team', icon: 'people' }));
    return html`<style>
        folio-audience { display: flex; flex-direction: column; gap: var(--space-4); }
        folio-audience .folio-audience-add { display: flex; align-items: flex-end; gap: var(--space-4); flex-wrap: wrap; }
        folio-audience .folio-audience-add ui-text-field { flex: 1; min-width: 12rem; }
      </style>
      <ui-list label=${this.label} density="compact" .noun=${['audience', 'audiences']} .items=${chosen} empty=${this.empty}
        @ui-action=${(e: CustomEvent<{ item: ListItem }>) => this.set(this.chosen.filter((c) => c.principal !== e.detail.item.id))}></ui-list>
      <div class="folio-audience-add">
        <ui-text-field label="Add a team" placeholder="A team’s name" .value=${this.query} @ui-input=${(e: CustomEvent<{ value: string }>) => this.search(e.detail.value)}></ui-text-field>
        <ui-toggle label="And the teams below it" .checked=${this.below} @ui-change=${(e: CustomEvent<{ checked: boolean }>) => (this.below = e.detail.checked)}></ui-toggle>
      </div>
      ${this.found
        ? html`<ui-list label="Teams found" density="compact" .noun=${['team', 'teams']} .items=${teams} empty="No team by that name."
            @ui-open=${(e: CustomEvent<{ item: ListItem }>) => {
              const team = e.detail.item;
              this.add(`${this.below ? 'tree' : 'team'}:${team.id}`, this.below ? `${team.title} and the teams below it` : `${team.title} (just that team)`);
            }}></ui-list>`
        : nothing}
      ${this.org && !this.chosen.some((c) => c.principal === 'org')
        ? html`<div class="folio-actions"><ui-button kind="ghost" size="sm" @click=${() => this.add('org', 'Everyone in the org')}>Add the whole org</ui-button></div>`
        : nothing}
      ${this.note ? html`<p class="folio-note" role="status">${this.note}</p>` : nothing}`;
  }
}

if (!customElements.get('folio-audience')) customElements.define('folio-audience', FolioAudience);

declare global {
  interface HTMLElementTagNameMap {
    'folio-audience': FolioAudience;
  }
}
