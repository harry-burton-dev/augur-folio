import { LitElement, html, nothing } from 'lit';
import type { ListItem } from '@augur/ui-kit';
import type { FolioApi, LevelInfo, UnitLevel } from './api.js';
import { DEFAULT_LEVELS } from './words.js';

export { DEFAULT_LEVELS };

/** A level's own name, before the org renamed it. */
const ownName = (id: UnitLevel) => DEFAULT_LEVELS.find((l) => l.id === id)!;

interface Naming {
  level: UnitLevel;
  name: string;
  plural: string;
}

/**
 * What the org calls each level of a library: collection, subcollection,
 * series, subseries and file. Everyone sees the names and what each level
 * holds; the org's leads, on the org's floor, rename them for the whole org or
 * give a level its own name back. A name changes nothing but the words: the
 * shape stays the same.
 *
 * @fires folio-levels - detail `{ levels }`, after each change
 */
export class FolioLevels extends LitElement {
  static override properties = {
    api: { attribute: false },
    levels: { state: true },
    rename: { state: true },
    failure: { state: true },
    naming: { state: true },
    busy: { state: true },
    note: { state: true },
  };

  declare api: FolioApi;
  declare levels: LevelInfo[] | undefined;
  /** May the person rename them: the org's leads, on the org's floor. */
  declare rename: boolean;
  declare failure: string;
  declare naming: Naming | undefined;
  declare busy: boolean;
  declare note: string;

  constructor() {
    super();
    this.rename = false;
    this.failure = '';
    this.busy = false;
    this.note = '';
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
      const { levels, can } = await this.api.levels();
      this.levels = levels;
      this.rename = can.rename;
    } catch (err) {
      this.failure = (err as Error).message;
    }
  }

  private rows(levels: LevelInfo[]): ListItem[] {
    return levels.map((l) => {
      const own = ownName(l.id);
      const renamed = own.name !== l.name || own.plural !== l.plural;
      const holds = l.holds.map((h) => levels.find((x) => x.id === h)?.plural.toLowerCase() ?? h);
      return {
        id: l.id,
        title: l.name,
        detail: [`More than one: ${l.plural}`, holds.length ? `Holds ${holds.join(' and ')}` : 'What everything else holds', renamed ? `Its own name is ${own.name}` : ''].filter(Boolean).join(' · '),
        ...(this.rename
          ? {
              actions: [
                { id: 'rename', label: 'Rename' },
                ...(renamed ? [{ id: 'reset', label: `Call it ${own.name} again` }] : []),
              ],
            }
          : {}),
      };
    });
  }

  private act(e: CustomEvent<{ item: ListItem; action: { id: string } }>) {
    const level = this.levels?.find((l) => l.id === e.detail.item.id);
    if (!level) return;
    if (e.detail.action.id === 'rename') this.naming = { level: level.id, name: level.name, plural: level.plural };
    else void this.save(level.id, null, `It’s called ${ownName(level.id).name} again.`);
  }

  private async save(level: UnitLevel, name: { name: string; plural: string } | null, done: string) {
    this.busy = true;
    try {
      const { levels } = await this.api.nameLevel(level, name);
      this.levels = levels;
      this.naming = undefined;
      this.note = done;
      this.dispatchEvent(new CustomEvent('folio-levels', { detail: { levels }, bubbles: true }));
    } catch (err) {
      this.note = (err as Error).message;
    } finally {
      this.busy = false;
    }
  }

  private form(naming: Naming) {
    const name = naming.name.trim();
    const plural = naming.plural.trim();
    const ready = Boolean(name && plural);
    return html`<section class="folio-levels-form" aria-label=${`Rename ${ownName(naming.level).name.toLowerCase()}`}>
      <ui-text-field name="level-name" label="Name" required maxlength="30" .value=${naming.name}
        @ui-input=${(e: CustomEvent<{ value: string }>) => (this.naming = { ...this.naming!, name: e.detail.value })}></ui-text-field>
      <ui-text-field name="level-plural" label="More than one" required maxlength="30" .value=${naming.plural}
        hint="As in “3 Programmes”."
        @ui-input=${(e: CustomEvent<{ value: string }>) => (this.naming = { ...this.naming!, plural: e.detail.value })}></ui-text-field>
      <div class="folio-actions">
        <ui-button kind="primary" size="sm" ?disabled=${!ready} reason="Give it a name, and a name for more than one." ?busy=${this.busy} busy-label="Saving…"
          @click=${() => void this.save(naming.level, { name, plural }, `The whole org calls it ${name} now.`)}>Save</ui-button>
        <ui-button kind="ghost" size="sm" @click=${() => (this.naming = undefined)}>Cancel</ui-button>
      </div>
    </section>`;
  }

  override render() {
    if (this.failure) return html`<ui-state kind="error" heading="Couldn’t see the level names" body=${this.failure} action="Try again" @ui-action=${() => void this.load()}></ui-state>`;
    const levels = this.levels;
    if (!levels) return html`<ui-state kind="loading" heading="Seeing what the levels are called"></ui-state>`;
    return html`<style>
        folio-levels { display: flex; flex-direction: column; gap: var(--space-4); }
        folio-levels .folio-levels-form { display: flex; flex-direction: column; gap: var(--space-3); }
        folio-levels .folio-levels-hint { margin: 0; color: var(--ink-muted); }
      </style>
      <p class="folio-levels-hint">
        Every library has the same shape, top down. A level can be skipped but never moved.
        ${this.rename ? 'Renaming one renames it for the whole org.' : 'The org’s leads choose what they’re called, from the org’s floor.'}
      </p>
      <ui-list label="Levels" density="compact" .noun=${['level', 'levels']} .items=${this.rows(levels)}
        @ui-action=${(e: CustomEvent<{ item: ListItem; action: { id: string } }>) => this.act(e)}></ui-list>
      ${this.naming ? this.form(this.naming) : nothing}
      <p class="folio-note" role="status">${this.note}</p>`;
  }
}

if (!customElements.get('folio-levels')) customElements.define('folio-levels', FolioLevels);

declare global {
  interface HTMLElementTagNameMap {
    'folio-levels': FolioLevels;
  }
}
