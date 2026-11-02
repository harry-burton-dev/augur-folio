import { Button, List, TextField, Toggle, type ListItem } from '@augur/app-kit';
import { useEffect, useRef, useState } from 'react';
import type { FolioApi, Found } from '../api.js';

/** A principal as the audience list shows it before it's saved: named from what the person picked. */
export interface Chosen {
  principal: string;
  name: string;
}

export interface AudienceProps {
  api: FolioApi;
  label?: string;
  /** What the list says while no one is in it. */
  empty?: string;
  /** The whole org may be added: the person has the publisher role. */
  org?: boolean;
  chosen: Chosen[];
  onChange: (chosen: Chosen[]) => void;
}

/**
 * Who something goes to: teams found by name (with the teams below them, or
 * just that team), or the whole org for whoever may publish there. A series
 * picks the audience of its issues with it, and publishing a version's.
 */
export function Audience({ api, label = 'Who it goes to', empty = 'Add a team, or the whole org.', org = false, chosen, onChange }: AudienceProps) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<Found>();
  const [below, setBelow] = useState(true);
  const [note, setNote] = useState('');
  const asked = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const search = (q: string) => {
    setQuery(q);
    clearTimeout(timer.current);
    if (!q.trim()) return setFound(undefined);
    const mine = ++asked.current;
    timer.current = setTimeout(() => {
      api.people(q.trim()).then(
        (f) => mine === asked.current && setFound(f),
        (err: Error) => mine === asked.current && setNote(err.message),
      );
    }, 200);
  };

  const add = (principal: string, name: string) => {
    const id = principal.slice(principal.indexOf(':') + 1);
    // One way in for each team: just it, or it and those below.
    onChange([...chosen.filter((c) => c.principal !== `team:${id}` && c.principal !== `tree:${id}`), { principal, name }]);
    setQuery('');
    setFound(undefined);
  };

  const rows: ListItem[] = chosen.map((c) => ({ id: c.principal, title: c.name, icon: c.principal === 'org' ? 'org' : 'people', actions: [{ id: 'remove', label: 'Remove' }] }));
  const teams: ListItem[] = (found?.teams ?? []).map((t) => ({ id: t.id, title: t.name, detail: t.within.length ? `Team in ${t.within.join(' / ')}` : 'Team', icon: 'people' }));
  return (
    <div className="folio-audience" data-folio-audience>
      <List label={label} density="compact" noun={['audience', 'audiences']} items={rows} empty={empty} onAction={(item) => onChange(chosen.filter((c) => c.principal !== item.id))} />
      <div className="folio-audience-add">
        <TextField label="Add a team" placeholder="A team’s name" value={query} onChange={search} />
        <Toggle label="And the teams below it" checked={below} onChange={setBelow} />
      </div>
      {found ? (
        <List
          label="Teams found"
          density="compact"
          noun={['team', 'teams']}
          items={teams}
          empty="No team by that name."
          onOpen={(team) => add(`${below ? 'tree' : 'team'}:${team.id}`, below ? `${team.title} and the teams below it` : `${team.title} (just that team)`)}
        />
      ) : null}
      {org && !chosen.some((c) => c.principal === 'org') ? (
        <div>
          <Button kind="tertiary" size="sm" onPress={() => add('org', 'Everyone in the org')}>
            Add the whole org
          </Button>
        </div>
      ) : null}
      {note ? (
        <p className="folio-picker-note" role="status">
          {note}
        </p>
      ) : null}
    </div>
  );
}
