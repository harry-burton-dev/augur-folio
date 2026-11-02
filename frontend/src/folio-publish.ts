import { LitElement, html, nothing } from 'lit';
import { ago, type ListItem, type SelectOption } from '@augur/ui-kit';
import type { FolioApi, Principal, Publication, Publications } from './api.js';
import './folio-audience.js';
import type { Chosen } from './folio-audience.js';
import { whoWords } from './folio-share.js';

/** When, in a sentence: "just now", "4 min ago". */
export const agoWords = (time: string) => {
  const short = ago(time);
  return short === 'now' ? 'just now' : `${short} ago`;
};

import { audienceWords } from './words.js';
export { audienceWords };

/** How a publication ended, or that it's out. */
const endWords = (p: Publication<Principal>) =>
  !p.ended ? 'Out now' : p.ended.as === 'withdrawn' ? `Withdrawn ${agoWords(p.ended.at)}${p.ended.reason ? `: ${p.ended.reason}` : ''}` : `Replaced ${agoWords(p.ended.at)}`;

/**
 * Publishing a document: what's out now and to whom, putting a version out
 * to teams or the whole org (replacing what was out), taking it back, and
 * every time it was published before. Sits inside a dialog.
 *
 * @fires folio-published - after a version is put out or taken back
 */
export class FolioPublish extends LitElement {
  static override properties = {
    api: { attribute: false },
    library: { type: String },
    document: { type: String },
    versions: { attribute: false },
    issue: { type: Boolean },
    history: { state: true },
    floor: { state: true },
    failure: { state: true },
    version: { state: true },
    chosen: { state: true },
    withdrawing: { state: true },
    busy: { state: true },
    note: { state: true },
  };

  declare api: FolioApi;
  declare library: string;
  declare document: string;
  /** The document's version numbers, newest first. */
  declare versions: number[];
  /** True for a series' issue: only issues are still put out one version at a time. Anything else is published up the floors. */
  declare issue: boolean;
  declare history: Publications | undefined;
  /** Who the library's floor lets in. */
  declare floor: Principal | undefined;
  declare failure: string;
  /** The version to publish. */
  declare version: number;
  declare chosen: Chosen[];
  /** Asking why before taking it back. */
  declare withdrawing: boolean;
  declare busy: boolean;
  declare note: string;

  constructor() {
    super();
    this.library = '';
    this.document = '';
    this.versions = [];
    this.issue = false;
    this.failure = '';
    this.version = 0;
    this.chosen = [];
    this.withdrawing = false;
    this.busy = false;
    this.note = '';
  }

  override createRenderRoot() {
    return this;
  }

  override willUpdate(changed: Map<string, unknown>) {
    if ((changed.has('api') || changed.has('library') || changed.has('document')) && this.api && this.library && this.document) void this.load();
    if (changed.has('versions') && !this.versions.includes(this.version)) this.version = this.versions[0] ?? 0;
  }

  private async load() {
    this.failure = '';
    try {
      const [history, access] = await Promise.all([this.api.publications(this.library, this.document), this.api.access(this.library, { document: this.document })]);
      this.history = history;
      this.floor = access.floor;
      this.chosen = this.startWith(history, access.floor);
    } catch (err) {
      this.failure = (err as Error).message;
    }
  }

  /** Who a new publication goes to at first: who the one out went to, or the floor's team and those below it. */
  private startWith(history: Publications, floor: Principal): Chosen[] {
    const out = history.publications.find((p) => !p.ended);
    if (out) return out.audience.map((p) => ({ principal: p.principal, name: whoWords(p) }));
    if (floor.kind === 'tree') return [{ principal: floor.principal, name: whoWords(floor) }];
    if (floor.kind === 'org' && history.can.publishToOrg) return [{ principal: 'org', name: 'Everyone in the org' }];
    return [];
  }

  private async publish() {
    const note = this.querySelector<HTMLElement & { value: string }>('ui-text-field[name="publish-note"]')?.value.trim();
    this.busy = true;
    try {
      const out = await this.api.publish(this.library, this.document, this.version, this.chosen.map((c) => c.principal), note || undefined);
      this.note = `Version ${out.version} is out to ${audienceWords(out.audience)}.`;
      this.history = await this.api.publications(this.library, this.document);
      this.dispatchEvent(new CustomEvent('folio-published', { bubbles: true }));
    } catch (err) {
      this.note = (err as Error).message;
    } finally {
      this.busy = false;
    }
  }

  private async withdraw() {
    const reason = this.querySelector<HTMLElement & { value: string }>('ui-text-field[name="withdraw-reason"]')?.value.trim();
    this.busy = true;
    try {
      const back = await this.api.withdraw(this.library, this.document, reason || undefined);
      this.note = `Version ${back.version} is withdrawn: only those who could see it before can read it now.`;
      this.withdrawing = false;
      this.history = await this.api.publications(this.library, this.document);
      this.dispatchEvent(new CustomEvent('folio-published', { bubbles: true }));
    } catch (err) {
      this.note = (err as Error).message;
    } finally {
      this.busy = false;
    }
  }

  private out() {
    const out = this.history?.publications.find((p) => !p.ended);
    if (!out) return html`<p class="folio-publish-lead">It hasn’t been published: only those who can see the collection, or it’s been shared with, can read it.</p>`;
    return html`<div class="folio-publish-out">
      <p class="folio-publish-lead"><ui-icon name="publish" size="20"></ui-icon> Version ${out.version} went out to ${audienceWords(out.audience)} ${agoWords(out.publishedAt)}.</p>
      ${out.note ? html`<p class="folio-publish-said">“${out.note}”</p>` : nothing}
      ${this.history?.can.publish
        ? this.withdrawing
          ? html`<ui-text-field name="withdraw-reason" label="Why it’s withdrawn" optional maxlength="500" hint="It goes on the record with it."></ui-text-field>
              <div class="folio-actions">
                <ui-button kind="danger" once size="sm" ?busy=${this.busy} busy-label="Withdrawing…" @click=${() => void this.withdraw()}>Withdraw version ${out.version}</ui-button>
                <ui-button kind="ghost" size="sm" @click=${() => (this.withdrawing = false)}>Keep it out</ui-button>
              </div>`
          : html`<div class="folio-actions"><ui-button kind="secondary" size="sm" @click=${() => (this.withdrawing = true)}>Withdraw</ui-button></div>`
        : nothing}
    </div>`;
  }

  private form() {
    const history = this.history!;
    if (!history.can.publish) return nothing;
    if (!this.issue)
      return html`<p class="folio-publish-hint">A document is published up the floors now: close this and choose Publish up the floors, and which states it shows. What went out before keeps reading as it did until Artifacts moves it there.</p>`;
    const out = history.publications.find((p) => !p.ended);
    const versionOptions: SelectOption[] = this.versions.map((n, i) => ({ value: String(n), label: `Version ${n}${i === 0 ? ', the newest' : ''}`, ...(out?.version === n ? { detail: 'Out now' } : {}) }));
    const own = this.floor?.kind === 'person';
    return html`<section class="folio-publish-form" aria-label="Publish a version">
      <ui-select label="Version" .options=${versionOptions} .value=${String(this.version)} @ui-change=${(e: CustomEvent<{ value: string }>) => (this.version = Number(e.detail.value))}></ui-select>
      <folio-audience .api=${this.api} .chosen=${this.chosen} ?org=${history.can.publishToOrg}
        empty=${own && !history.can.publishToOrg ? 'Publishing from your own floor needs the publisher role. Share it instead.' : 'Add a team, or the whole org.'}
        @folio-change=${(e: CustomEvent<{ chosen: Chosen[] }>) => (this.chosen = e.detail.chosen)}></folio-audience>
      <ui-text-field name="publish-note" label="A word about it" optional multiline maxlength="500" hint="It goes with the notification, and stays with the version."></ui-text-field>
      <div class="folio-actions">
        <ui-button kind="primary" size="sm" ?disabled=${!this.chosen.length || !this.version}
          reason=${!this.version ? 'There’s no version to publish yet.' : 'Choose who to publish it to first.'} ?busy=${this.busy} busy-label="Publishing…" @click=${() => void this.publish()}>
          ${!out ? `Publish version ${this.version}` : out.version === this.version ? 'Publish it again' : `Publish version ${this.version} instead`}
        </ui-button>
      </div>
      <p class="folio-publish-hint">Everyone it goes to can read this version from their own floor, and is told it’s there. Only this version: not the others, nor the rest of the library.</p>
    </section>`;
  }

  override render() {
    if (this.failure) return html`<ui-state kind="error" heading="Couldn’t see how it’s published" body=${this.failure} action="Try again" @ui-action=${() => void this.load()}></ui-state>`;
    const history = this.history;
    if (!history) return html`<ui-state kind="loading" heading="Seeing how it’s published"></ui-state>`;
    const before: ListItem[] = history.publications.map((p) => ({
      id: p.id,
      title: `Version ${p.version} to ${audienceWords(p.audience)}`,
      detail: endWords(p),
      icon: p.ended ? (p.ended.as === 'withdrawn' ? 'withdraw' : 'document') : 'publish',
      meta: ago(p.publishedAt),
    }));
    return html`<style>
        folio-publish { display: flex; flex-direction: column; gap: var(--space-5); }
        folio-publish .folio-publish-lead { display: flex; align-items: center; gap: var(--space-3); margin: 0; }
        folio-publish .folio-publish-out, folio-publish .folio-publish-form { display: flex; flex-direction: column; gap: var(--space-4); }
        folio-publish .folio-publish-said { margin: 0; color: var(--ink-muted); }
        folio-publish .folio-publish-hint { margin: 0; font-size: var(--type-small); color: var(--ink-muted); }
      </style>
      ${this.out()} ${this.form()}
      ${history.publications.length ? html`<ui-list label="Published before" density="compact" .noun=${['time', 'times']} .items=${before}></ui-list>` : nothing}
      <p class="folio-note" role="status">${this.note}</p>`;
  }
}

if (!customElements.get('folio-publish')) customElements.define('folio-publish', FolioPublish);

declare global {
  interface HTMLElementTagNameMap {
    'folio-publish': FolioPublish;
  }
}
