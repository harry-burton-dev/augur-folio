import { LitElement, html, nothing } from 'lit';
import { ago, type ListItem } from '@augur/ui-kit';
import { ACCEPT, MAX_UPLOAD_MB, type FolioApi, type FolioDocument, type Principal, type SeriesView } from './api.js';
import { audienceWords, CADENCE_WORDS, issueDetail, nextWords } from './words.js';

export { CADENCE_WORDS, dayWords, issueDetail, nextWords } from './words.js';

type Loaded = Omit<SeriesView, 'audience'> & { audience: Principal[] };

/**
 * A series on its own page: how often it comes out and who its issues go to,
 * the issue it expects next and the way to add it (one file, everything else
 * from the series), following it, and its issues, newest first.
 *
 * @fires folio-read - detail `{ library, document }`, to read an issue
 * @fires folio-edit-series - detail `{ series }`, to change it (whoever manages its library)
 * @fires folio-delete-series - detail `{ series }`, to remove it while it has no issues
 * @fires folio-issue-added - detail `{ document }`, after an issue goes up
 */
export class FolioSeries extends LitElement {
  static override properties = {
    api: { attribute: false },
    series: { type: String },
    loaded: { state: true },
    issues: { state: true },
    failure: { state: true },
    adding: { state: true },
    note: { state: true },
  };

  declare api: FolioApi;
  declare series: string;
  declare loaded: Loaded | undefined;
  declare issues: FolioDocument[];
  declare failure: string;
  declare adding: boolean;
  declare note: string;

  constructor() {
    super();
    this.series = '';
    this.issues = [];
    this.failure = '';
    this.adding = false;
    this.note = '';
  }

  override createRenderRoot() {
    return this;
  }

  override willUpdate(changed: Map<string, unknown>) {
    if ((changed.has('api') || changed.has('series')) && this.api && this.series) void this.load();
  }

  async load() {
    this.failure = '';
    try {
      const [loaded, { documents }] = await Promise.all([this.api.series(this.series), this.api.issues(this.series)]);
      this.loaded = loaded;
      this.issues = documents;
    } catch (err) {
      this.failure = (err as Error).message;
    }
  }

  private emit(name: string, detail: object) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
  }

  private async follow(on: boolean) {
    try {
      await this.api.follow(this.series, on);
      this.loaded = { ...this.loaded!, following: on };
    } catch (err) {
      this.note = (err as Error).message;
    }
  }

  private async add(file: File | undefined) {
    const run = this.loaded;
    if (!run || !file) return;
    this.adding = true;
    this.note = '';
    try {
      const issue = await this.api.addIssue(run.library, run.id, file);
      this.note = issue.draft
        ? `Added ${issue.title} as a draft. ${issue.draft}`
        : issue.state === 'published'
          ? `${issue.title} is out to ${audienceWords(run.audience)}.`
          : `Added ${issue.title}.`;
      this.emit('folio-issue-added', { document: issue.id });
      await this.load();
    } catch (err) {
      this.note = `Couldn’t add ${file.name}: ${(err as Error).message}`;
    } finally {
      this.adding = false;
    }
  }

  override render() {
    if (this.failure) return html`<ui-state kind="error" heading="Couldn’t open the series" body=${this.failure} action="Try again" @ui-action=${() => void this.load()}></ui-state>`;
    const run = this.loaded;
    if (!run) return html`<ui-state kind="loading" heading="Opening the series"></ui-state>`;
    const rows: ListItem[] = this.issues.map((d) => ({
      id: d.id,
      title: d.title,
      icon: d.state === 'published' ? 'publish' : 'document',
      detail: issueDetail(d),
      meta: ago(d.createdAt),
    }));
    const goesTo = run.audience.length ? `Each issue goes out to ${audienceWords(run.audience)} as it’s added.` : 'Issues stay drafts until someone publishes them.';
    return html`<style>
        folio-series { display: flex; flex-direction: column; gap: var(--space-5); }
        folio-series .folio-series-facts { display: flex; flex-direction: column; gap: var(--space-2); margin: 0; }
        folio-series .folio-series-facts p { display: flex; align-items: center; gap: var(--space-2); margin: 0; }
        folio-series .folio-series-late { color: var(--warn-ink, var(--ink)); }
      </style>
      <div class="folio-head">
        <ui-heading eyebrow=${`A series in ${run.libraryName}`} heading=${run.name} summary=${run.description}></ui-heading>
        <div class="folio-actions">
          ${run.can.manage ? html`<ui-button kind="ghost" size="sm" @click=${() => this.emit('folio-edit-series', { series: run.id })}>Change it</ui-button>` : nothing}
          ${run.can.manage && !run.issues ? html`<ui-button kind="ghost" size="sm" @click=${() => this.emit('folio-delete-series', { series: run.id })}>Remove</ui-button>` : nothing}
        </div>
      </div>
      <div class="folio-series-facts">
        <p><ui-icon name="series" size="18"></ui-icon>${CADENCE_WORDS[run.cadence]}. ${goesTo}</p>
        <p class=${run.next.overdue ? 'folio-series-late' : ''}><ui-icon name=${run.next.overdue ? 'warning' : 'clock'} size="18"></ui-icon>${nextWords(run)}</p>
      </div>
      <ui-toggle label="Tell me of each new issue" hint="You’re told when one is published to you." ?checked=${run.following}
        @ui-change=${(e: CustomEvent<{ checked: boolean }>) => void this.follow(e.detail.checked)}></ui-toggle>
      ${run.can.addIssue
        ? html`<ui-drop-zone
            heading=${`Drop the ${run.cadence === 'adhoc' ? 'next issue' : `issue for ${run.next.period}`} here`}
            hint=${`It’s named, tagged${run.audience.length && run.can.publish ? ' and published' : ''} for you. PDF, Word, HTML, Markdown or text, up to ${MAX_UPLOAD_MB} MB.`}
            action="Choose a file"
            accept=${ACCEPT}
            .multiple=${false}
            ?busy=${this.adding}
            @ui-files=${(e: CustomEvent<{ files: File[] }>) => void this.add(e.detail.files[0])}
            @ui-reject=${() => (this.note = 'Artifacts takes PDF, Word (.docx), HTML, Markdown and plain text.')}
          ></ui-drop-zone>`
        : nothing}
      <ui-surface>
        <ui-list label=${`Issues of ${run.name}`} density="compact" .noun=${['issue', 'issues']} .items=${rows}
          empty=${run.can.addIssue ? 'No issues yet. Drop the first one above.' : 'No issues you can read yet.'}
          @ui-open=${(e: CustomEvent<{ item: ListItem }>) => this.emit('folio-read', { library: run.library, document: e.detail.item.id })}></ui-list>
      </ui-surface>
      <p class="folio-note" role="status">${this.adding ? 'Adding the issue…' : this.note}</p>`;
  }
}

if (!customElements.get('folio-series')) customElements.define('folio-series', FolioSeries);

declare global {
  interface HTMLElementTagNameMap {
    'folio-series': FolioSeries;
  }
}
