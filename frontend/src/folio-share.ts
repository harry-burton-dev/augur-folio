import { LitElement, html, nothing } from 'lit';
import { isIntentCancelled } from '@augur/mfe-sdk';
import { ago, type ListItem, type Principal as Someone, type SelectOption } from '@augur/ui-kit';
import { stateName, type Access, type AccessTarget, type ContentState, type FolioApi, type Grant, type Level, type Principal } from './api.js';

export const LEVEL_WORDS: Record<Level, string> = { read: 'Can read', edit: 'Can edit', manage: 'Can manage' };

const LEVEL_OPTIONS = (document: boolean): SelectOption[] => [
  { value: 'read', label: 'Can read', detail: 'Read and download' },
  { value: 'edit', label: 'Can edit', detail: document ? 'And add versions' : 'And add or change documents' },
  { value: 'manage', label: 'Can manage', detail: 'And share it' },
];

/** Who a principal is, in a few words: "Kim Lee", "Payroll and the teams below it", "Everyone in the org". */
export const whoWords = (p: Principal) => {
  if (p.kind === 'org') return 'Everyone in the org';
  if (!p.name) return p.kind === 'person' ? 'Someone no longer here' : 'A team that’s gone';
  return p.kind === 'tree' ? `${p.name} and the teams below it` : p.kind === 'team' ? `${p.name} (just that team)` : p.name;
};

/** The line under a name: an email, or where a team sits. */
const detailOf = (p: Principal) => (p.kind === 'person' ? (p.email ?? '') : p.within?.length ? `In ${p.within.join(' / ')}` : p.kind === 'org' ? '' : 'Team');

/** Asks another app to explain who can open something (`access.explain`), set by the entry. */
export type Explainer = (payload: ExplainPayload) => Promise<unknown>;

/** What's being shared: a whole library, a folder and everything inside it, or one document. */
export type Shareable = 'library' | 'folder' | 'document';

export interface ExplainPayload {
  thing: { app: 'folio'; appName: string; id: string; title: string; kind: Shareable };
  audience: { principal: string; name?: string; level?: Level; since?: string; via: string; chain?: string[]; shows?: string[] }[];
  change: { where: string; allowed: boolean };
}

/**
 * What Artifacts sends with `access.explain`: everyone who can see it, and how
 * each one reaches it: its floor, its library, a folder it's inside, or shared
 * with it alone.
 */
export const explainPayload = (access: Access, thing: { id: string; title: string; kind: Shareable }): ExplainPayload => {
  const shared = (g: Grant, via: string) => ({ principal: g.principal, ...(g.name ? { name: g.name } : {}), level: g.level, since: g.createdAt, via });
  const floor = access.floor;
  return {
    thing: { app: 'folio', appName: 'Artifacts', id: thing.id, title: thing.title, kind: thing.kind },
    audience: [
      { principal: floor.principal, ...(floor.name ? { name: floor.name } : {}), level: floor.kind === 'person' ? 'manage' : 'read', via: 'its floor' },
      ...(access.library ?? []).map((g) => shared(g, 'its collection')),
      ...(access.folders ?? []).map((g) => shared(g, 'a folder it’s in')),
      ...(access.placed ?? []).map((p) => ({
        principal: p.principal,
        ...(p.name ? { name: p.name } : {}),
        level: 'read' as const,
        since: p.at,
        via: p.record.id === thing.id ? 'published up to them' : 'published up inside something',
        chain: p.chain.map(inSentence),
        shows: p.filter.map(stateName),
      })),
      ...access.grants.map((g) => shared(g, `shared with this ${thing.kind}`)),
    ],
    change: { where: 'Share', allowed: access.can.share },
  };
};

/** A list in words: "Complete", "Complete and Issued", "In review, Complete and Issued". */
const listWords = (list: readonly string[]) => (list.length < 2 ? (list[0] ?? '') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);

/** A floor's name in the middle of a sentence: "your own floor" and "the org" aren't names. */
const inSentence = (floor: string) => (floor === 'Your own floor' || floor === 'The org' ? floor[0].toLowerCase() + floor.slice(1) : floor);

/** How a step up the floors reaches them: "Up from Payroll through Finance · Shows Complete and Issued". */
export const upLine = (p: { chain: readonly string[]; filter: readonly ContentState[] }) => {
  const [from, ...through] = p.chain.map(inSentence);
  return [from ? `Up from ${from}${through.length ? ` through ${listWords(through)}` : ''}` : '', `Shows ${listWords(p.filter.map(stateName))}`].filter(Boolean).join(' · ');
};

const iconOf = (p: Principal) => (p.kind === 'person' ? 'account' : p.kind === 'org' ? 'org' : 'people');

/** Who its floor lets in, as a sentence. */
export const floorWords = (floor: Principal, what: Shareable, me = '') => {
  const it = what === 'library' ? 'this collection' : `this ${what}’s collection`;
  if (floor.principal === `person:${me}`) return 'It’s on your own floor: only you can see it, and whoever you share it with.';
  if (floor.kind === 'person') return `It’s on ${floor.name ? `${floor.name}’s` : 'someone’s'} own floor: only they can see it, and whoever they share it with.`;
  if (floor.kind === 'org') return `It’s on the org’s floor, so everyone in the org can read it. The org’s leads manage ${it}.`;
  return `Everyone on ${floor.name ?? 'its team'}, and the teams below it, can read it and add to ${it} there. ${floor.name ?? 'The team'}’s leads manage it.`;
};

interface Pick {
  principal: string;
  name: string;
  team: boolean;
  /** For a team: share with the teams below it too. */
  below: boolean;
  level: Level;
  /** Already let in: this changes how far. */
  existing: boolean;
}

/**
 * Who may see a library or a document, and, for whoever manages it, letting
 * people and teams in, changing how far, and taking them out. Sits inside a
 * dialog; every change is saved as it's made.
 *
 * @fires folio-shared - detail `{ access }`, after each change
 */
export class FolioShare extends LitElement {
  static override properties = {
    api: { attribute: false },
    library: { type: String },
    document: { type: String },
    folder: { type: String },
    name: { type: String },
    me: { type: String },
    explain: { attribute: false },
    folderNames: { attribute: false },
    access: { state: true },
    failure: { state: true },
    pick: { state: true },
    busy: { state: true },
    note: { state: true },
  };

  declare api: FolioApi;
  declare library: string;
  /** Just this document; the whole library when there's neither it nor a folder. */
  declare document: string | undefined;
  /** This folder and everything inside it. */
  declare folder: string | undefined;
  /** What it's called, for the explanation's heading. */
  declare name: string;
  /** Opens "Who can open this, explained" from another app; no link without it. */
  declare explain: Explainer | undefined;
  /** Who is signed in, so their own floor reads as theirs. */
  declare me: string;
  /** The library's folders by id, to say which one a document is shared through. */
  declare folderNames: ReadonlyMap<string, string>;
  declare access: Access | undefined;
  declare failure: string;
  declare pick: Pick | undefined;
  declare busy: boolean;
  /** What the last change did, for screen readers and eyes. */
  declare note: string;

  constructor() {
    super();
    this.library = '';
    this.name = '';
    this.me = '';
    this.folderNames = new Map();
    this.failure = '';
    this.busy = false;
    this.note = '';
  }

  override createRenderRoot() {
    return this;
  }

  override willUpdate(changed: Map<string, unknown>) {
    if ((changed.has('api') || changed.has('library') || changed.has('document') || changed.has('folder')) && this.api && this.library) void this.load();
  }

  private get what(): Shareable {
    return this.document ? 'document' : this.folder ? 'folder' : 'library';
  }

  private get on(): AccessTarget | undefined {
    return this.document ? { document: this.document } : this.folder ? { folder: this.folder } : undefined;
  }

  private async load() {
    this.failure = '';
    try {
      this.access = await this.api.access(this.library, this.on);
    } catch (err) {
      this.failure = (err as Error).message;
    }
  }

  /** People and teams by name, each saying how far it's already let in. */
  private readonly search = async (q: string): Promise<Someone[]> => {
    const found = await this.api.people(q);
    return [
      ...found.people.map((p): Someone => ({ kind: 'person', id: p.id, name: p.name, ...(p.email ? { detail: p.email } : {}), ...this.already(`person:${p.id}`) })),
      ...found.teams.map((t): Someone => ({ kind: 'team', id: t.id, name: t.name, ...(t.within.length ? { detail: `In ${t.within.join(' / ')}` } : {}), ...this.already(`tree:${t.id}`, `team:${t.id}`) })),
    ];
  };

  private already(...principals: string[]) {
    const level = principals.map((p) => this.levelOf(p)).find(Boolean);
    return level ? { meta: LEVEL_WORDS[level] } : {};
  }

  private choose(found: Someone) {
    const team = found.kind === 'team';
    const principal = team ? `tree:${found.id}` : `person:${found.id}`;
    const had = this.levelOf(principal) ?? this.levelOf(`team:${found.id}`);
    this.pick = { principal, name: found.name, team, below: true, level: had ?? 'read', existing: Boolean(had) };
  }

  private levelOf(principal: string) {
    return this.access?.grants.find((g) => g.principal === principal)?.level;
  }

  private change(grant: Grant) {
    this.pick = { principal: grant.principal, name: whoWords(grant), team: grant.kind === 'team' || grant.kind === 'tree', below: grant.kind !== 'team', level: grant.level, existing: true };
  }

  private async save(principal: string, level: Level | null, done: string) {
    this.busy = true;
    try {
      this.access = await this.api.share(this.library, this.on, principal, level);
      this.note = done;
      this.dispatchEvent(new CustomEvent('folio-shared', { detail: { access: this.access }, bubbles: true }));
      return true;
    } catch (err) {
      this.note = (err as Error).message;
      return false;
    } finally {
      this.busy = false;
    }
  }

  private async share() {
    const pick = this.pick;
    if (!pick) return;
    const id = pick.principal.slice(pick.principal.indexOf(':') + 1);
    const principal = pick.team ? `${pick.below ? 'tree' : 'team'}:${id}` : pick.principal;
    // A team shared just with itself, now with the teams below too (or back): one grant, not two.
    const other = pick.team ? `${pick.below ? 'team' : 'tree'}:${id}` : undefined;
    if (other && this.levelOf(other)) await this.save(other, null, '');
    if (await this.save(principal, pick.level, `${pick.name}: ${LEVEL_WORDS[pick.level].toLowerCase()}.`)) this.pick = undefined;
  }

  private grantRows(grants: (Grant & { through?: string })[], editable: boolean): ListItem[] {
    return grants.map((g) => ({
      id: g.through ? `${g.through}/${g.principal}` : g.principal,
      title: whoWords(g),
      detail: [detailOf(g), g.through, `Shared ${ago(g.createdAt)}`].filter(Boolean).join(' · '),
      icon: iconOf(g),
      meta: LEVEL_WORDS[g.level],
      ...(editable
        ? {
            actions: [
              { id: 'change', label: 'Change' },
              { id: 'remove', label: 'Remove' },
            ],
          }
        : {}),
    }));
  }

  private onGrantAction(e: CustomEvent<{ item: ListItem; action: { id: string } }>) {
    const grant = this.access?.grants.find((g) => g.principal === e.detail.item.id);
    if (!grant) return;
    if (e.detail.action.id === 'change') this.change(grant);
    else void this.save(grant.principal, null, `${whoWords(grant)} can no longer see it through this.`);
  }

  /** Opens the explanation over Artifacts; when no app can give one, says so here instead. */
  private async explained(access: Access) {
    if (!this.explain) return;
    try {
      await this.explain(explainPayload(access, { id: this.document ?? this.folder ?? this.library, title: this.name, kind: this.what }));
    } catch (err) {
      if (isIntentCancelled(err)) return;
      this.note = `Couldn’t explain it: ${(err as Error).message} Who can see it is still listed here.`;
    }
  }

  private form() {
    const pick = this.pick;
    if (!pick)
      return html`<ui-people-picker label="Share with" ?disabled=${this.busy} .search=${this.search}
        @ui-pick=${(e: CustomEvent<{ principal: Someone }>) => this.choose(e.detail.principal)}></ui-people-picker>`;
    return html`<div class="folio-share-pick">
      <p class="folio-share-who"><ui-icon name=${pick.team ? 'people' : 'account'} size="20"></ui-icon>${pick.name}</p>
      ${pick.team
        ? html`<ui-toggle label="And the teams below it" .checked=${pick.below} @ui-change=${(e: CustomEvent<{ checked: boolean }>) => (this.pick = { ...pick, below: e.detail.checked })}></ui-toggle>`
        : nothing}
      <ui-select label="How far" .options=${LEVEL_OPTIONS(this.what === 'document')} .value=${pick.level}
        @ui-change=${(e: CustomEvent<{ value: string }>) => (this.pick = { ...pick, level: e.detail.value as Level })}></ui-select>
      <div class="folio-actions">
        <ui-button kind="primary" size="sm" ?busy=${this.busy} @click=${() => void this.share()}>${pick.existing ? 'Save' : 'Share'}</ui-button>
        <ui-button kind="ghost" size="sm" @click=${() => (this.pick = undefined)}>Cancel</ui-button>
      </div>
    </div>`;
  }

  override render() {
    if (this.failure) return html`<ui-state kind="error" heading="Couldn’t see who has it" body=${this.failure} action="Try again" @ui-action=${() => void this.load()}></ui-state>`;
    const access = this.access;
    if (!access) return html`<ui-state kind="loading" heading="Seeing who has it"></ui-state>`;
    const what = this.what;
    const folders = (access.folders ?? []).map((g) => ({ ...g, through: `Through ${this.folderNames.get(g.folder) ?? 'a folder it’s in'}` }));
    return html`<style>
        folio-share { display: flex; flex-direction: column; gap: var(--space-5); }
        folio-share .folio-share-floor { margin: 0; color: var(--ink-muted); }
        folio-share .folio-share-pick { display: flex; flex-direction: column; gap: var(--space-4); }
        folio-share .folio-share-who { display: flex; align-items: center; gap: var(--space-3); margin: 0; font-weight: 600; }
      </style>
      <p class="folio-share-floor">${floorWords(access.floor, what, this.me)}${what === 'folder' ? ' Whoever you share this folder with sees everything inside it, while it’s inside.' : ''}</p>
      ${this.explain
        ? html`<div class="folio-actions"><ui-button kind="tertiary" size="sm" @click=${() => void this.explained(access)}>Who can open this, explained</ui-button></div>`
        : nothing}
      ${access.can.share
        ? this.form()
        : what === 'folder'
          ? html`<p class="folio-share-floor">Only whoever manages the collection shares a folder.</p>`
          : nothing}
      <ui-list label=${what === 'library' ? 'Shared with' : `Shared with, for this ${what}`} density="compact" .noun=${['person or team', 'people and teams']}
        .items=${this.grantRows(access.grants, access.can.share)}
        empty=${what === 'library' ? 'It hasn’t been shared beyond its floor.' : `No one else has been let into this ${what} alone.`}
        @ui-action=${(e: CustomEvent<{ item: ListItem; action: { id: string } }>) => this.onGrantAction(e)}></ui-list>
      ${folders.length
        ? html`<ui-list label="Shared with, through a folder it’s in" density="compact" .noun=${['person or team', 'people and teams']} .items=${this.grantRows(folders, false)}></ui-list>`
        : nothing}
      ${access.placed?.length
        ? html`<ui-list label="Published up to" density="compact" .noun=${['floor', 'floors']}
            .items=${access.placed.map((p, i): ListItem => ({
              id: `up-${i}`,
              title: whoWords(p),
              detail: [upLine(p), p.record.id === (this.document ?? this.folder ?? this.library) ? '' : 'With what it’s inside'].filter(Boolean).join(' · '),
              icon: iconOf(p),
              meta: 'Can read',
            }))}></ui-list>`
        : nothing}
      ${what !== 'library' && access.library?.length
        ? html`<ui-list label="Shared with, through its collection" density="compact" .noun=${['person or team', 'people and teams']} .items=${this.grantRows(access.library, false)}></ui-list>`
        : nothing}
      <p class="folio-note" role="status">${this.note}</p>`;
  }
}

if (!customElements.get('folio-share')) customElements.define('folio-share', FolioShare);

declare global {
  interface HTMLElementTagNameMap {
    'folio-share': FolioShare;
  }
}
