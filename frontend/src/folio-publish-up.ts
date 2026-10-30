import { LitElement, html, nothing } from 'lit';
import type { ListItem, PathStep, SelectOption } from '@augur/ui-kit';
import { CONTENT_STATES, type ContentState, type FloorView, type FolioApi, type Placement, type Placements, type RecordView } from './api.js';
import { agoWords } from './folio-publish.js';

/** "Complete and Issued": what a step lets through, in words. */
export const filterWords = (filter: readonly string[]) => {
  const names = CONTENT_STATES.filter((s) => filter.includes(s.id)).map((s) => s.name);
  return names.length <= 1 ? (names[0] ?? 'nothing') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};

/** A floor's name as a sentence says it: "the org", "Finance", "your own floor". */
export const floorWords = (floor: FloorView | undefined) => (!floor ? 'a floor that’s gone' : floor.kind === 'org' ? 'the org' : floor.kind === 'personal' ? 'your own floor' : floor.name);

/** What a newly published step lets through at first: what's done, never the working states. */
const DEFAULT_FILTER: ContentState[] = ['complete', 'issued'];

/**
 * The floors a record sits on, from its own floor to the top, as a path: the
 * one that owns it marked, the one you're standing on ringed.
 */
export const chainSteps = (own: FloorView | undefined, live: readonly Placement[], owner: FloorView | undefined, here?: string): PathStep[] => {
  const floors = new Map<string, { floor: FloorView; filter?: ContentState[] }>();
  if (own) floors.set(own.id, { floor: own });
  for (const p of live) if (p.toFloor) floors.set(p.toFloor.id, { floor: p.toFloor, filter: p.filter });
  return [...floors.values()]
    .sort((a, b) => a.floor.rank - b.floor.rank)
    .map(({ floor, filter }) => ({
      id: floor.id,
      floor: floor.kind,
      title: floor.kind === 'org' ? 'The org' : floor.name,
      line: filter ? `Shows ${filterWords(filter).toLowerCase()}` : 'Where it’s kept',
      ...(owner?.id === floor.id ? { mark: 'Owns it' } : {}),
      ...(here === floor.id ? { here: true } : {}),
    }));
};

/**
 * Publishing a collection, folder or document up the floors: where it is now
 * and who owns it, each step it took (to change or take back, for whoever
 * published it), and publishing it to a floor above, through a filter of
 * lifecycle states. Floors it can't go to stay in the list and say why.
 * Sits inside a dialog.
 *
 * @fires folio-placed - after a step is added, changed or taken back
 */
export class FolioPublishUp extends LitElement {
  static override properties = {
    api: { attribute: false },
    library: { type: String },
    record: { attribute: false },
    here: { type: String },
    data: { state: true },
    failure: { state: true },
    target: { state: true },
    filter: { state: true },
    withdrawing: { state: true },
    busy: { state: true },
    note: { state: true },
  };

  declare api: FolioApi;
  declare library: string;
  declare record: { kind: RecordView['kind']; id: string; name: string } | undefined;
  /** The floor the person is standing on, as placements name it. */
  declare here: string;
  declare data: Placements | undefined;
  declare failure: string;
  /** Where to publish it: an index into `data.targets`. */
  declare target: number;
  declare filter: ContentState[];
  /** The step being taken back, asking why first. */
  declare withdrawing: string | undefined;
  declare busy: boolean;
  declare note: string;

  constructor() {
    super();
    this.library = '';
    this.here = '';
    this.failure = '';
    this.target = -1;
    this.filter = DEFAULT_FILTER;
    this.busy = false;
    this.note = '';
  }

  override createRenderRoot() {
    return this;
  }

  override willUpdate(changed: Map<string, unknown>) {
    if ((changed.has('api') || changed.has('library') || changed.has('record')) && this.api && this.library && this.record) void this.load();
  }

  async load() {
    this.failure = '';
    try {
      this.data = await this.api.placements(this.library, this.record!.id);
      this.target = this.data.targets.findIndex((t) => !t.why);
      this.fit();
    } catch (err) {
      this.failure = (err as Error).message;
    }
  }

  /** Keeps the filter within what can go on from the chosen floor. */
  private fit() {
    const most = this.data?.targets[this.target]?.most;
    if (!most) return;
    const kept = this.filter.filter((s) => most.includes(s));
    this.filter = kept.length ? kept : [...most];
  }

  private async publish() {
    const target = this.data!.targets[this.target];
    const note = this.querySelector<HTMLElement & { value: string }>('ui-text-field[name="placement-note"]')?.value.trim();
    this.busy = true;
    try {
      const placed = await this.api.publishUp({
        library: this.library,
        record: { kind: this.record!.kind, id: this.record!.id },
        to: target.to!.id,
        filter: this.filter,
        ...(target.via ? { via: target.via } : {}),
        ...(note ? { note } : {}),
      });
      this.note = `${this.record!.name} is on ${floorWords(placed.toFloor)} now, showing ${filterWords(placed.filter).toLowerCase()}. Its leads were told.`;
      await this.load();
      this.dispatchEvent(new CustomEvent('folio-placed', { bubbles: true }));
    } catch (err) {
      this.note = (err as Error).message;
    } finally {
      this.busy = false;
    }
  }

  private async withdraw(id: string) {
    const reason = this.querySelector<HTMLElement & { value: string }>('ui-text-field[name="placement-reason"]')?.value.trim();
    this.busy = true;
    try {
      const back = await this.api.withdrawPlacement(id, reason || undefined);
      this.note = `It’s off ${floorWords(back.toFloor)}, and off every floor it went to from there.`;
      this.withdrawing = undefined;
      await this.load();
      this.dispatchEvent(new CustomEvent('folio-placed', { bubbles: true }));
    } catch (err) {
      this.note = (err as Error).message;
    } finally {
      this.busy = false;
    }
  }

  private steps(data: Placements) {
    const live = data.placements.filter((p) => !p.ended);
    if (!live.length) return html`<p class="folio-up-lead">It’s only on its own floor. Publish it up and the floor above sees what it lets through, as it changes.</p>`;
    const rows: ListItem[] = live.map((p) => ({
      id: p.id,
      title: `On ${floorWords(p.toFloor)}`,
      detail: [`Shows ${filterWords(p.filter).toLowerCase()}`, p.note].filter(Boolean).join(' · '),
      icon: 'publish',
      meta: agoWords(p.at),
      ...(p.can?.change ? { actions: [{ id: 'withdraw', label: 'Take it back' }] } : {}),
    }));
    const taking = live.find((p) => p.id === this.withdrawing);
    return html`<ui-list label="Where it’s been published" density="compact" .noun=${['floor', 'floors']} .items=${rows}
        @ui-action=${(e: CustomEvent<{ item: ListItem }>) => (this.withdrawing = e.detail.item.id)}></ui-list>
      ${taking
        ? html`<ui-text-field name="placement-reason" label="Why it’s taken back" optional maxlength="500" hint="It comes off every floor it went to from there too, and goes on the record."></ui-text-field>
            <div class="folio-actions">
              <ui-button kind="danger" once size="sm" ?busy=${this.busy} busy-label="Taking it back…" @click=${() => void this.withdraw(taking.id)}>Take it off ${floorWords(taking.toFloor)}</ui-button>
              <ui-button kind="ghost" size="sm" @click=${() => (this.withdrawing = undefined)}>Leave it there</ui-button>
            </div>`
        : nothing}`;
  }

  private form(data: Placements) {
    if (!data.targets.length) return html`<p class="folio-up-hint">Only whoever manages it can publish it up, or the leads of a floor it reached can take it further.</p>`;
    const options: SelectOption[] = data.targets.map((t, i) => ({
      value: String(i),
      label: t.to?.kind === 'org' ? 'The org' : (t.to?.name ?? 'A floor that’s gone'),
      ...(t.why ? { disabled: true, detail: t.why } : t.via ? { detail: `On from ${floorWords(t.from)}` } : {}),
    }));
    const chosen = data.targets[this.target];
    const allowed = chosen?.most ?? CONTENT_STATES.map((s) => s.id);
    return html`<section class="folio-up-form" aria-label="Publish it up">
      <ui-select label="Publish it to" .options=${options} .value=${this.target >= 0 ? String(this.target) : ''}
        @ui-change=${(e: CustomEvent<{ value: string }>) => {
          this.target = Number(e.detail.value);
          this.fit();
        }}></ui-select>
      <ui-checkbox-group label="Showing versions that are" required
        hint=${chosen?.most ? `It can show no more than reached ${floorWords(chosen.from)}.` : 'New versions show as they reach these states.'}
        .options=${CONTENT_STATES.filter((s) => allowed.includes(s.id)).map((s) => ({ value: s.id, label: s.name }))}
        .values=${this.filter}
        @ui-change=${(e: CustomEvent<{ values: string[] }>) => (this.filter = e.detail.values as ContentState[])}></ui-checkbox-group>
      <ui-text-field name="placement-note" label="A word about it" optional multiline maxlength="500" hint="It goes with the notification."></ui-text-field>
      <div class="folio-actions">
        <ui-button kind="primary" size="sm" ?disabled=${!chosen || chosen.why || !this.filter.length}
          reason=${!chosen || chosen.why ? 'Choose a floor it can go to first.' : 'Choose at least one state to show.'}
          ?busy=${this.busy} busy-label="Publishing…" @click=${() => void this.publish()}>Publish to ${floorWords(chosen?.to)}</ui-button>
      </div>
      <p class="folio-up-hint">Only up, never sideways. The highest floor it reaches owns it, and each person sees it in one place: the highest floor that shows it to them.</p>
    </section>`;
  }

  override render() {
    if (this.failure) return html`<ui-state kind="error" heading="Couldn’t see where it’s published" body=${this.failure} action="Try again" @ui-action=${() => void this.load()}></ui-state>`;
    const data = this.data;
    if (!data) return html`<ui-state kind="loading" heading="Seeing where it’s published"></ui-state>`;
    const live = data.placements.filter((p) => !p.ended);
    const own = live[0]?.chain[0]?.from ?? data.owner;
    return html`<style>
        folio-publish-up { display: flex; flex-direction: column; gap: var(--space-5); }
        folio-publish-up .folio-up-lead { margin: 0; }
        folio-publish-up .folio-up-form { display: flex; flex-direction: column; gap: var(--space-4); }
        folio-publish-up .folio-up-hint { margin: 0; font-size: var(--type-small); color: var(--ink-muted); }
      </style>
      ${live.length ? html`<ui-path .steps=${chainSteps(own, live, data.owner, this.here)}></ui-path>` : nothing}
      ${data.owner && live.length ? html`<p class="folio-up-lead">${floorWords(data.owner) === 'the org' ? 'The org owns it' : `${floorWords(data.owner)} owns it`}: the highest floor it has reached decides about it now.</p>` : nothing}
      ${this.steps(data)} ${this.form(data)}
      <p class="folio-note" role="status">${this.note}</p>`;
  }
}

if (!customElements.get('folio-publish-up')) customElements.define('folio-publish-up', FolioPublishUp);

declare global {
  interface HTMLElementTagNameMap {
    'folio-publish-up': FolioPublishUp;
  }
}

