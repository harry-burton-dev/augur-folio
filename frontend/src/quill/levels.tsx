import { Button, List, State, TextField, type ListItem } from '@augur/app-kit';
import { useCallback, useEffect, useState } from 'react';
import type { FolioApi, LevelInfo, UnitLevel } from '../api.js';
import { ownLevel } from '../words.js';

interface Naming {
  level: UnitLevel;
  name: string;
  plural: string;
}

export interface LevelsProps {
  api: FolioApi;
  /** After each change, with the levels as they now are. */
  onLevels?: (levels: LevelInfo[]) => void;
}

/**
 * What the org calls each level of a library: collection, subcollection,
 * series, subseries and file. Everyone sees the names and what each level
 * holds; the org's leads, on the org's floor, rename them for the whole org or
 * give a level its own name back. A name changes nothing but the words.
 */
export function Levels({ api, onLevels }: LevelsProps) {
  const [levels, setLevels] = useState<LevelInfo[]>();
  const [rename, setRename] = useState(false);
  const [failure, setFailure] = useState('');
  const [naming, setNaming] = useState<Naming>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setFailure('');
    try {
      const got = await api.levels();
      setLevels(got.levels);
      setRename(got.can.rename);
    } catch (err) {
      setFailure((err as Error).message);
    }
  }, [api]);
  useEffect(() => void load(), [load]);

  const save = async (level: UnitLevel, name: { name: string; plural: string } | null, done: string) => {
    setBusy(true);
    try {
      const got = await api.nameLevel(level, name);
      setLevels(got.levels);
      setNaming(undefined);
      setNote(done);
      onLevels?.(got.levels);
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (failure) return <State kind="error" heading="Couldn’t see the level names" body={failure} action="Try again" onAction={() => void load()} />;
  if (!levels) return <State kind="loading" heading="Seeing what the levels are called" />;
  const rows: ListItem[] = levels.map((l) => {
    const own = ownLevel(l.id);
    const renamed = own.name !== l.name || own.plural !== l.plural;
    const holds = l.holds.map((h) => levels.find((x) => x.id === h)?.plural.toLowerCase() ?? h);
    return {
      id: l.id,
      title: l.name,
      detail: [`More than one: ${l.plural}`, holds.length ? `Holds ${holds.join(' and ')}` : 'What everything else holds', renamed ? `Its own name is ${own.name}` : ''].filter(Boolean).join(' · '),
      ...(rename ? { actions: [{ id: 'rename', label: 'Rename' }, ...(renamed ? [{ id: 'reset', label: `Call it ${own.name} again` }] : [])] } : {}),
    };
  });
  const name = naming?.name.trim() ?? '';
  const plural = naming?.plural.trim() ?? '';
  return (
    <div className="folio-levels" data-folio-levels>
      <p className="folio-picker-note">
        Every library has the same shape, top down. A level can be skipped but never moved. {rename ? 'Renaming one renames it for the whole org.' : 'The org’s leads choose what they’re called, from the org’s floor.'}
      </p>
      <List
        label="Levels"
        density="compact"
        noun={['level', 'levels']}
        items={rows}
        onAction={(item, action) => {
          const level = levels.find((l) => l.id === item.id);
          if (!level) return;
          if (action.id === 'rename') setNaming({ level: level.id, name: level.name, plural: level.plural });
          else void save(level.id, null, `It’s called ${ownLevel(level.id).name} again.`);
        }}
      />
      {naming ? (
        <section className="folio-levels-form" aria-label={`Rename ${ownLevel(naming.level).name.toLowerCase()}`}>
          <TextField label="Name" required maxLength={30} value={naming.name} onChange={(v) => setNaming({ ...naming, name: v })} />
          <TextField label="More than one" required maxLength={30} value={naming.plural} hint="As in “3 Programmes”." onChange={(v) => setNaming({ ...naming, plural: v })} />
          <div className="folio-series-actions">
            <Button kind="primary" size="sm" disabled={!name || !plural} reason="Give it a name, and a name for more than one." busy={busy} busyLabel="Saving…" onPress={() => void save(naming.level, { name, plural }, `The whole org calls it ${name} now.`)}>
              Save
            </Button>
            <Button kind="tertiary" size="sm" onPress={() => setNaming(undefined)}>
              Cancel
            </Button>
          </div>
        </section>
      ) : null}
      <p className="folio-picker-note" role="status">
        {note}
      </p>
    </div>
  );
}
