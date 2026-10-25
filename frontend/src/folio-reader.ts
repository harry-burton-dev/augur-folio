import { LitElement, html, nothing } from 'lit';
import { ago, type ListItem, type OutlineItem, type ReaderSize, type UiReader } from '@augur/ui-kit';
import { agoWords } from './folio-publish.js';
import { fileTypeOf, sizeWords, type DocumentVersion, type FolioApi, type OpenDocument, type Tag } from './api.js';

/** How a person likes to read, kept in their browser for every document. */
export interface ReadingPrefs {
  size: ReaderSize;
  wide: boolean;
}

const PREFS = 'folio:reading';
const SIZES: ReaderSize[] = ['small', 'medium', 'large'];

/** Storage that may not be there (private windows, blocked site data): reading still works without it. */
const stored = {
  get(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Not remembered this time.
    }
  },
};

export const readingPrefs = (): ReadingPrefs => {
  try {
    const saved = JSON.parse(stored.get(PREFS) ?? '{}') as Partial<ReadingPrefs>;
    return { size: SIZES.includes(saved.size as ReaderSize) ? (saved.size as ReaderSize) : 'medium', wide: saved.wide === true };
  } catch {
    return { size: 'medium', wide: false };
  }
};

/** Where someone got to in a version, by its block's anchor. */
const placeKey = (version: string) => `folio:read:${version}`;

/** A picture's name in a reader copy, as the worker writes them. */
const PICTURE = /^images\/(\d{1,5}\.png)$/;

/**
 * A document to read: its reader copy in the middle, its contents beside it,
 * and beside that what it is, its versions and tags, the original to download,
 * and the way to change it. The version shown is the one in the address, or the
 * newest.
 *
 * @fires folio-read - detail `{ version? }`, to read another version (none: the newest)
 * @fires folio-back - back to the library
 * @fires folio-manage - open the document's details, to change it
 * @fires folio-share - see who can see it, and share it when the person manages it
 * @fires folio-publish - see how it's published, and publish or withdraw it when the person manages it
 * @fires folio-download - detail `{ version }`, the original of a version
 * @fires folio-retry - detail `{ version }`, ask again for a reader copy that failed
 * @fires folio-issue - detail `{ library, document }`, to read the issue before or after this one
 * @fires folio-series - detail `{ series }`, to open this issue's series
 * @fires folio-follow - detail `{ following }`, to be told of each new issue, or not
 */
export class FolioReader extends LitElement {
  static override properties = {
    api: { attribute: false },
    doc: { attribute: false },
    version: { type: Number },
    tags: { attribute: false },
    libraryName: { type: String, attribute: 'library-name' },
    markdown: { state: true },
    failure: { state: true },
    outline: { state: true },
    current: { state: true },
    prefs: { state: true },
  };

  declare api: FolioApi;
  declare doc: OpenDocument;
  /** The version in the address; the newest when there's none. */
  declare version: number | undefined;
  /** The tags the library's documents can have, to name the document's. */
  declare tags: Tag[];
  declare libraryName: string;
  declare markdown: string | undefined;
  declare failure: string;
  declare outline: OutlineItem[];
  declare current: string;
  declare prefs: ReadingPrefs;

  /** The version whose reader copy is loaded, so a refresh of the document doesn't load it again. */
  private loaded = '';
  private pictures: string[] = [];
  private restored = false;

  constructor() {
    super();
    this.tags = [];
    this.libraryName = '';
    this.failure = '';
    this.outline = [];
    this.current = '';
    this.prefs = readingPrefs();
  }

  override createRenderRoot() {
    return this;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.forgetPictures();
  }

  /** The version being read. */
  get shown(): DocumentVersion | undefined {
    return this.doc?.versions.find((v) => v.number === (this.version ?? this.doc.latest.number));
  }

  override willUpdate(changed: Map<string, unknown>) {
    if (changed.has('doc') || changed.has('version')) void this.load();
  }

  private forgetPictures() {
    for (const url of this.pictures) URL.revokeObjectURL(url);
    this.pictures = [];
  }

  private async load() {
    const v = this.shown;
    const key = v?.reader.state === 'ready' ? `${v.id}` : '';
    if (key === this.loaded) return;
    this.loaded = key;
    this.markdown = undefined;
    this.failure = '';
    this.outline = [];
    this.current = '';
    this.restored = false;
    this.forgetPictures();
    if (!v || !key) return;
    try {
      const text = await this.api.reader(this.doc.library, this.doc.id, v.number);
      if (this.loaded === key) this.markdown = text;
    } catch (err) {
      if (this.loaded === key) this.failure = (err as Error).message;
    }
  }

  /** Pictures come from Folio, by the names the worker gave them, and nowhere else. */
  private imageSource = async (src: string) => {
    const v = this.shown;
    const name = src.match(PICTURE)?.[1];
    if (!v || !name) return undefined;
    const url = URL.createObjectURL(await this.api.readerImage(this.doc.library, this.doc.id, v.number, name));
    this.pictures.push(url);
    return url;
  };

  private get reader() {
    return this.querySelector<UiReader>('ui-reader');
  }

  private onOutline(e: CustomEvent<{ headings: OutlineItem[] }>) {
    this.outline = e.detail.headings;
    const v = this.shown;
    const saved = v && stored.get(placeKey(v.id));
    // Back where they were, without taking focus from wherever it is.
    if (saved && !this.restored && this.reader?.goTo(saved, { smooth: false, focus: false })) this.current = this.reader.headingFor(saved);
    this.restored = true;
  }

  private onPosition(e: CustomEvent<{ anchor: string }>) {
    const v = this.shown;
    if (v) stored.set(placeKey(v.id), e.detail.anchor);
    this.current = this.reader?.headingFor(e.detail.anchor) ?? '';
  }

  private setPrefs(change: Partial<ReadingPrefs>) {
    this.prefs = { ...this.prefs, ...change };
    stored.set(PREFS, JSON.stringify(this.prefs));
  }

  private emit(name: string, detail: object = {}) {
    this.dispatchEvent(new CustomEvent(name, { detail, bubbles: true }));
  }

  /** What's in the middle: the reader copy, or why there isn't one yet. */
  private body(v: DocumentVersion) {
    switch (v.reader.state) {
      case 'queued':
      case 'running':
        return html`<ui-state kind="loading" heading="Making the reader copy" body="It shows here as soon as it’s ready. The original can be downloaded now."></ui-state>`;
      case 'failed':
        return html`<ui-state kind="error" heading="There’s no reader copy of this version" body=${v.reader.error ?? 'Folio couldn’t make one.'}
            action=${this.doc.can.change ? 'Try again' : ''} @ui-action=${() => this.emit('folio-retry', { version: v.number })}></ui-state>`;
      default:
        if (this.failure) return html`<ui-state kind="error" heading="The reader copy didn’t load" body=${this.failure}></ui-state>`;
        if (this.markdown === undefined) return html`<ui-state kind="loading" heading="Opening the document"></ui-state>`;
        return html`<ui-reader
          size=${this.prefs.size}
          width=${this.prefs.wide ? 'wide' : 'narrow'}
          .markdown=${this.markdown}
          heading=${this.doc.title}
          .imageSource=${this.imageSource}
          @ui-outline=${this.onOutline}
          @ui-position=${this.onPosition}
        ></ui-reader>`;
    }
  }

  /** Where it is in being published, and the way to publish it for whoever manages it. */
  private publishing() {
    const doc = this.doc;
    const words = doc.only
      ? `Version ${doc.only} was published to you${doc.published ? ` ${agoWords(doc.published.publishedAt)}` : ''}.`
      : doc.state === 'published' && doc.published
        ? `Version ${doc.published.version} was published ${agoWords(doc.published.publishedAt)}.`
        : doc.state === 'withdrawn'
          ? 'It was published, and has been withdrawn.'
          : 'A draft: it hasn’t been published.';
    return html`<section class="folio-reader-publishing" aria-label="Publishing">
      <p class="folio-reader-said"><ui-icon name=${doc.state === 'published' ? 'publish' : doc.state === 'withdrawn' ? 'withdraw' : 'document'} size="18"></ui-icon>${words}</p>
      ${doc.published?.note && doc.only ? html`<p class="folio-reader-note">“${doc.published.note}”</p>` : nothing}
      ${doc.can.publish ? html`<ui-button kind="secondary" size="sm" @click=${() => this.emit('folio-publish')}>${doc.state === 'published' ? 'Publishing' : 'Publish'}</ui-button>` : nothing}
    </section>`;
  }

  /** Where an issue comes in its series, following it, and the way to the series. */
  private series() {
    const { run, issue } = this.doc;
    if (!run || !issue) return nothing;
    const at = issue.period.startsWith('Issue') ? `Issue ${issue.number}` : `Issue ${issue.number}, ${issue.period}`;
    return html`<section class="folio-reader-series" aria-label="Series">
      <p class="folio-reader-said"><ui-icon name="series" size="18"></ui-icon><span>${at}, in <button class="folio-link" @click=${() => this.emit('folio-series', { series: run.id })}>${run.name}</button></span></p>
      <ui-toggle label="Tell me of each new issue" ?checked=${run.following} @ui-change=${(e: CustomEvent<{ checked: boolean }>) => this.emit('folio-follow', { following: e.detail.checked })}></ui-toggle>
    </section>`;
  }

  /** The issues either side, under the title. */
  private turns() {
    const { run } = this.doc;
    if (!run?.previous && !run?.next) return nothing;
    return html`<nav class="folio-reader-turns" aria-label="Other issues">
      ${run.previous
        ? html`<ui-button kind="ghost" size="sm" @click=${() => this.emit('folio-issue', { library: run.previous!.library, document: run.previous!.id })}>Previous: ${run.previous.period}</ui-button>`
        : html`<span></span>`}
      ${run.next ? html`<ui-button kind="ghost" size="sm" @click=${() => this.emit('folio-issue', { library: run.next!.library, document: run.next!.id })}>Next: ${run.next.period}</ui-button>` : nothing}
    </nav>`;
  }

  private side(v: DocumentVersion) {
    const doc = this.doc;
    const newest = doc.latest.number;
    const versions: ListItem[] = doc.versions.map((x) => ({
      id: String(x.number),
      title: x.number === v.number ? `Version ${x.number}, reading` : `Version ${x.number}`,
      icon: 'document',
      detail: [sizeWords(x.size), x.number === newest ? 'newest' : '', x.number === doc.published?.version ? 'published' : ''].filter(Boolean).join(' · '),
      meta: ago(x.createdAt),
    }));
    const size = SIZES.indexOf(this.prefs.size);
    return html`<aside class="folio-reader-side" aria-label="About this document">
      <section class="folio-reader-facts">
        <span class="label">Text size</span>
        <div class="folio-reader-row" role="group" aria-label="Text size">
          <ui-button kind="secondary" size="sm" ?disabled=${size === 0} @click=${() => this.setPrefs({ size: SIZES[size - 1] })}>Smaller</ui-button>
          <ui-button kind="secondary" size="sm" ?disabled=${size === SIZES.length - 1} @click=${() => this.setPrefs({ size: SIZES[size + 1] })}>Larger</ui-button>
        </div>
        <ui-toggle label="Wide page" ?checked=${this.prefs.wide} @ui-change=${(e: CustomEvent<{ checked: boolean }>) => this.setPrefs({ wide: e.detail.checked })}></ui-toggle>
      </section>
      <div class="folio-reader-row">
        <ui-button kind="secondary" size="sm" @click=${() => this.emit('folio-download', { version: v.number })}>Download the original</ui-button>
        ${doc.can.change ? html`<ui-button kind="ghost" size="sm" @click=${() => this.emit('folio-manage')}>Change it</ui-button>` : nothing}
        ${doc.only ? nothing : html`<ui-button kind="ghost" size="sm" @click=${() => this.emit('folio-share')}>${doc.can.share ? 'Share' : 'Who can see it'}</ui-button>`}
      </div>
      ${this.publishing()} ${this.series()}
      ${doc.tags.length
        ? html`<div class="folio-tags" aria-label="Tags">${doc.tags.map((t) => {
            const tag = this.tags.find((x) => x.id === t);
            return tag ? html`<ui-tag quiet label=${tag.name} icon=${tag.library ? '' : 'org'}></ui-tag>` : nothing;
          })}</div>`
        : nothing}
      <ui-list
        label="Versions"
        density="compact"
        .noun=${['version', 'versions']}
        .items=${versions}
        @ui-open=${(e: CustomEvent<{ item: ListItem }>) => {
          const n = Number(e.detail.item.id);
          this.emit('folio-read', n === newest ? {} : { version: n });
        }}
      ></ui-list>
    </aside>`;
  }

  override render() {
    const doc = this.doc;
    const v = this.shown;
    if (!doc) return nothing;
    if (!v) return html`<ui-state kind="empty" heading="There’s no such version of this document"></ui-state>`;
    const old = v.number !== doc.latest.number;
    return html`<style>
        folio-reader { display: grid; grid-template-columns: minmax(160px, 220px) minmax(0, 1fr) minmax(220px, 280px); gap: var(--space-6); align-items: start; }
        folio-reader .folio-reader-contents { position: sticky; top: var(--space-5); max-height: calc(100vh - var(--space-7)); overflow-y: auto; }
        folio-reader .folio-reader-main { display: flex; flex-direction: column; gap: var(--space-5); min-width: 0; }
        folio-reader .folio-reader-head { display: flex; flex-direction: column; gap: var(--space-2); max-width: var(--measure-read); width: 100%; margin: 0 auto; }
        folio-reader:has(ui-reader[width='wide']) .folio-reader-head { max-width: var(--measure-wide); }
        folio-reader .folio-reader-head h1 { margin: 0; font-size: var(--type-title-s); line-height: var(--leading-title-s); font-weight: 300; }
        folio-reader .folio-reader-head p { margin: 0; color: var(--ink-muted); font-size: var(--type-meta); line-height: var(--leading-meta); }
        folio-reader .folio-reader-old { color: var(--ink); }
        folio-reader .folio-reader-series { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-3); }
        folio-reader .folio-reader-turns { display: flex; justify-content: space-between; gap: var(--space-3); }
        folio-reader .folio-reader-publishing { display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-3); }
        folio-reader .folio-reader-said { display: flex; align-items: center; gap: var(--space-2); margin: 0; font-size: var(--type-small); }
        folio-reader .folio-reader-note { margin: 0; font-size: var(--type-small); color: var(--ink-muted); }
        folio-reader .folio-reader-side { position: sticky; top: var(--space-5); display: flex; flex-direction: column; gap: var(--space-5); }
        folio-reader .folio-reader-facts { display: flex; flex-direction: column; gap: var(--space-2); }
        folio-reader .folio-reader-row { display: flex; flex-wrap: wrap; gap: var(--space-2); }
        folio-reader .label { font-size: var(--type-label); line-height: var(--leading-label); letter-spacing: var(--tracking-label); text-transform: uppercase; color: var(--ink-muted); }
        folio-reader .folio-link { all: unset; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }
        folio-reader .folio-link:focus-visible { outline: 1.5px solid var(--focus); outline-offset: 2px; }
        @media (max-width: 1100px) {
          folio-reader { grid-template-columns: minmax(0, 1fr); }
          folio-reader .folio-reader-contents, folio-reader .folio-reader-side { position: static; max-height: none; }
          folio-reader .folio-reader-contents { order: 1; }
        }
      </style>
      <div class="folio-reader-contents">
        <ui-contents .items=${this.outline} current=${this.current} @ui-select=${(e: CustomEvent<{ id: string }>) => this.reader?.goTo(e.detail.id)}></ui-contents>
      </div>
      <div class="folio-reader-main">
        <header class="folio-reader-head">
          <nav aria-label="Where this is"><button class="folio-crumb" @click=${() => this.emit('folio-back')}>${this.libraryName}</button></nav>
          <h1>${doc.title}</h1>
          <p>${[`Version ${v.number}`, fileTypeOf(v.filename)?.word, `added ${ago(v.createdAt)}`].filter(Boolean).join(' · ')}${v.reader.pages ? ` · ${v.reader.pages} ${v.reader.pages === 1 ? 'page' : 'pages'}` : ''}</p>
          ${old
            ? html`<p class="folio-reader-old" role="note">
                This is version ${v.number}. The newest is version ${doc.latest.number}.
                <button class="folio-link" @click=${() => this.emit('folio-read')}>Read the newest</button>
              </p>`
            : nothing}
          ${this.turns()}
        </header>
        ${this.body(v)}
      </div>
      ${this.side(v)}`;
  }
}

if (!customElements.get('folio-reader')) customElements.define('folio-reader', FolioReader);

declare global {
  interface HTMLElementTagNameMap {
    'folio-reader': FolioReader;
  }
}
