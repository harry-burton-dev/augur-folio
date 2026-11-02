import { Button, Icon, List, PeoplePicker, Select, State, Toggle, relativeTime, type ListItem, type Principal as Someone, type SelectOption } from '@augur/app-kit';
import { isIntentCancelled } from '@augur/mfe-sdk';
import { useCallback, useEffect, useState } from 'react';
import type { Access, AccessTarget, FolioApi, Grant, Level, Principal } from '../api.js';
import { LEVEL_WORDS, explainPayload, floorWords, upLine, type Explainer, type Shareable } from '../folio-share.js';
import { whoWords } from '../words.js';

const levelOptions = (document: boolean): SelectOption[] => [
  { value: 'read', label: 'Can read', detail: 'Read and download' },
  { value: 'edit', label: 'Can edit', detail: document ? 'And add versions' : 'And add or change documents' },
  { value: 'manage', label: 'Can manage', detail: 'And share it' },
];

/** The line under a name: an email, or where a team sits. */
const detailOf = (p: Principal) => (p.kind === 'person' ? (p.email ?? '') : p.within?.length ? `In ${p.within.join(' / ')}` : p.kind === 'org' ? '' : 'Team');
const iconOf = (p: Principal) => (p.kind === 'person' ? 'account' : p.kind === 'org' ? 'org' : 'people') as 'account' | 'org' | 'people';

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

export interface ShareProps {
  api: FolioApi;
  library: string;
  /** Just this document; the whole collection when there's neither it nor a folder. */
  document?: string;
  /** This folder and everything inside it. */
  folder?: string;
  /** What it's called, for the explanation. */
  name: string;
  /** Who is signed in, so their own floor reads as theirs. */
  me: string;
  /** Opens "Who can open this, explained" from another app; no button without it. */
  explain?: Explainer;
  /** The collection's folders by id, to say which one a document is shared through. */
  folderNames?: ReadonlyMap<string, string>;
}

/**
 * Who may see a collection, folder or document, and, for whoever manages it,
 * letting people and teams in, changing how far, and taking them out. Sits
 * inside a dialog; every change is saved as it's made.
 */
export function Share({ api, library, document, folder, name, me, explain, folderNames = new Map() }: ShareProps) {
  const [access, setAccess] = useState<Access>();
  const [failure, setFailure] = useState('');
  const [pick, setPick] = useState<Pick>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const what: Shareable = document ? 'document' : folder ? 'folder' : 'library';
  const on: AccessTarget | undefined = document ? { document } : folder ? { folder } : undefined;

  const load = useCallback(async () => {
    setFailure('');
    try {
      setAccess(await api.access(library, document ? { document } : folder ? { folder } : undefined));
    } catch (err) {
      setFailure((err as Error).message);
    }
  }, [api, library, document, folder]);
  useEffect(() => void load(), [load]);

  const levelOf = (principal: string) => access?.grants.find((g) => g.principal === principal)?.level;
  const already = (...principals: string[]) => {
    const level = principals.map(levelOf).find(Boolean);
    return level ? { meta: LEVEL_WORDS[level] } : {};
  };
  const search = async (q: string): Promise<Someone[]> => {
    const found = await api.people(q);
    return [
      ...found.people.map((p): Someone => ({ kind: 'person', id: p.id, name: p.name, ...(p.email ? { detail: p.email } : {}), ...already(`person:${p.id}`) })),
      ...found.teams.map((t): Someone => ({ kind: 'team', id: t.id, name: t.name, ...(t.within.length ? { detail: `In ${t.within.join(' / ')}` } : {}), ...already(`tree:${t.id}`, `team:${t.id}`) })),
    ];
  };
  const choose = (found: Someone) => {
    const team = found.kind === 'team';
    const principal = team ? `tree:${found.id}` : `person:${found.id}`;
    const had = levelOf(principal) ?? levelOf(`team:${found.id}`);
    setPick({ principal, name: found.name, team, below: true, level: had ?? 'read', existing: Boolean(had) });
  };
  const save = async (principal: string, level: Level | null, done: string) => {
    setBusy(true);
    try {
      setAccess(await api.share(library, on, principal, level));
      setNote(done);
      return true;
    } catch (err) {
      setNote((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const share = async () => {
    if (!pick) return;
    const id = pick.principal.slice(pick.principal.indexOf(':') + 1);
    const principal = pick.team ? `${pick.below ? 'tree' : 'team'}:${id}` : pick.principal;
    // A team shared just with itself, now with the teams below too (or back): one grant, not two.
    const other = pick.team ? `${pick.below ? 'team' : 'tree'}:${id}` : undefined;
    if (other && levelOf(other)) await save(other, null, '');
    if (await save(principal, pick.level, `${pick.name}: ${LEVEL_WORDS[pick.level].toLowerCase()}.`)) setPick(undefined);
  };
  const grantRows = (grants: (Grant & { through?: string })[], editable: boolean): ListItem[] =>
    grants.map((g) => ({
      id: g.through ? `${g.through}/${g.principal}` : g.principal,
      title: whoWords(g),
      detail: [detailOf(g), g.through, `Shared ${relativeTime(g.createdAt)}`].filter(Boolean).join(' · '),
      icon: iconOf(g),
      meta: LEVEL_WORDS[g.level],
      ...(editable ? { actions: [{ id: 'change', label: 'Change' }, { id: 'remove', label: 'Remove' }] } : {}),
    }));
  const explained = async (a: Access) => {
    if (!explain) return;
    try {
      await explain(explainPayload(a, { id: document ?? folder ?? library, title: name, kind: what }));
    } catch (err) {
      if (isIntentCancelled(err)) return;
      setNote(`Couldn’t explain it: ${(err as Error).message} Who can see it is still listed here.`);
    }
  };

  if (failure) return <State kind="error" heading="Couldn’t see who has it" body={failure} action="Try again" onAction={() => void load()} />;
  if (!access) return <State kind="loading" heading="Seeing who has it" />;
  const folders = (access.folders ?? []).map((g) => ({ ...g, through: `Through ${folderNames.get(g.folder) ?? 'a folder it’s in'}` }));
  const noun: [string, string] = ['person or team', 'people and teams'];

  return (
    <div className="folio-share" data-folio-share="">
      <p className="folio-share-floor">
        {floorWords(access.floor, what, me)}
        {what === 'folder' ? ' Whoever you share this folder with sees everything inside it, while it’s inside.' : ''}
      </p>
      {explain ? (
        <div className="folio-actions">
          <Button kind="tertiary" size="sm" onPress={() => void explained(access)}>
            Who can open this, explained
          </Button>
        </div>
      ) : null}
      {access.can.share ? (
        pick ? (
          <div className="folio-share-pick">
            <p className="folio-share-who">
              <Icon name={pick.team ? 'people' : 'account'} size={20} />
              {pick.name}
            </p>
            {pick.team ? <Toggle label="And the teams below it" checked={pick.below} onChange={(below) => setPick({ ...pick, below })} /> : null}
            <Select label="How far" options={levelOptions(what === 'document')} value={pick.level} onChange={(v) => setPick({ ...pick, level: v as Level })} />
            <div className="folio-actions">
              <Button kind="primary" size="sm" busy={busy} onPress={() => void share()}>
                {pick.existing ? 'Save' : 'Share'}
              </Button>
              <Button kind="ghost" size="sm" onPress={() => setPick(undefined)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <PeoplePicker label="Share with" disabled={busy} reason="Saving the last change." search={search} onPick={choose} />
        )
      ) : what === 'folder' ? (
        <p className="folio-share-floor">Only whoever manages the collection shares a folder.</p>
      ) : null}
      <List
        label={what === 'library' ? 'Shared with' : `Shared with, for this ${what}`}
        density="compact"
        noun={noun}
        items={grantRows(access.grants, access.can.share)}
        empty={what === 'library' ? 'It hasn’t been shared beyond its floor.' : `No one else has been let into this ${what} alone.`}
        onAction={(item, action) => {
          const grant = access.grants.find((g) => g.principal === item.id);
          if (!grant) return;
          if (action.id === 'change') setPick({ principal: grant.principal, name: whoWords(grant), team: grant.kind === 'team' || grant.kind === 'tree', below: grant.kind !== 'team', level: grant.level, existing: true });
          else void save(grant.principal, null, `${whoWords(grant)} can no longer see it through this.`);
        }}
      />
      {folders.length ? <List label="Shared with, through a folder it’s in" density="compact" noun={noun} items={grantRows(folders, false)} /> : null}
      {access.placed?.length ? (
        <List
          label="Published up to"
          density="compact"
          noun={['floor', 'floors']}
          items={access.placed.map((p, i): ListItem => ({
            id: `up-${i}`,
            title: whoWords(p),
            detail: [upLine(p), p.record.id === (document ?? folder ?? library) ? '' : 'With what it’s inside'].filter(Boolean).join(' · '),
            icon: iconOf(p),
            meta: 'Can read',
          }))}
        />
      ) : null}
      {what !== 'library' && access.library?.length ? <List label="Shared with, through its collection" density="compact" noun={noun} items={grantRows(access.library, false)} /> : null}
      <p className="folio-note" role="status">
        {note}
      </p>
    </div>
  );
}
