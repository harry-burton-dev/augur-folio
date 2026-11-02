import { Button, Checkbox, CheckboxGroup, List, Path, Select, State, TextField, type ListItem, type PathStep, type SelectOption } from '@augur/app-kit';
import { useCallback, useEffect, useState } from 'react';
import { CONTENT_STATES, type ContentState, type FolioApi, type Placements, type RecordView } from '../api.js';
import { agoWords } from '../folio-publish.js';
import { chainSteps, filterWords, floorWords } from '../folio-publish-up.js';

/** What a newly published step lets through at first: what's done, never the working states. */
const DEFAULT_FILTER: ContentState[] = ['complete', 'issued'];

export interface PublishUpProps {
  api: FolioApi;
  library: string;
  record: { kind: RecordView['kind']; id: string; name: string };
  /** The floor the person is standing on, as placements name it. */
  here: string;
  /** A step was added, changed or taken back. */
  onPlaced?: () => void;
}

/**
 * Publishing a collection, folder or document up the floors: where it is now
 * and who owns it, each step it took (to take back, for whoever published
 * it), and publishing it to a floor above through a filter of lifecycle
 * states. Floors it can't go to stay in the list and say why.
 */
export function PublishUp({ api, library, record, here, onPlaced }: PublishUpProps) {
  const [data, setData] = useState<Placements>();
  const [failure, setFailure] = useState('');
  const [target, setTarget] = useState(-1);
  const [filter, setFilter] = useState<ContentState[]>(DEFAULT_FILTER);
  const [withdrawing, setWithdrawing] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [said, setSaid] = useState('');
  const [why, setWhy] = useState('');

  /** Keeps the filter within what can go on from the chosen floor. */
  const fit = (d: Placements | undefined, i: number) => {
    const most = d?.targets[i]?.most;
    if (!most) return;
    setFilter((was) => {
      const kept = was.filter((s) => most.includes(s));
      return kept.length ? kept : [...most];
    });
  };
  const load = useCallback(async () => {
    setFailure('');
    try {
      const d = await api.placements(library, record.id);
      const i = d.targets.findIndex((t) => !t.why);
      setData(d);
      setTarget(i);
      fit(d, i);
    } catch (err) {
      setFailure((err as Error).message);
    }
  }, [api, library, record.id]);
  useEffect(() => void load(), [load]);

  const act = async (run: () => Promise<string>) => {
    setBusy(true);
    try {
      setNote(await run());
      await load();
      onPlaced?.();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const publish = () =>
    act(async () => {
      const t = data!.targets[target]!;
      const placed = await api.publishUp({ library, record: { kind: record.kind, id: record.id }, to: t.to!.id, filter, ...(t.via ? { via: t.via } : {}), ...(said.trim() ? { note: said.trim() } : {}) });
      setSaid('');
      return `${record.name} is on ${floorWords(placed.toFloor)} now, showing ${filterWords(placed.filter).toLowerCase()}. Its leads were told.`;
    });
  const withdraw = (id: string) =>
    act(async () => {
      const back = await api.withdrawPlacement(id, why.trim() || undefined);
      setWithdrawing(undefined);
      setWhy('');
      return `It’s off ${floorWords(back.toFloor)}, and off every floor it went to from there.`;
    });

  if (failure) return <State kind="error" heading="Couldn’t see where it’s published" body={failure} action="Try again" onAction={() => void load()} />;
  if (!data) return <State kind="loading" heading="Seeing where it’s published" />;
  const live = data.placements.filter((p) => !p.ended);
  const own = live[0]?.chain[0]?.from ?? data.owner;
  const rows: ListItem[] = live.map((p) => ({
    id: p.id,
    title: `On ${floorWords(p.toFloor)}`,
    detail: [`Shows ${filterWords(p.filter).toLowerCase()}`, p.note].filter(Boolean).join(' · '),
    icon: 'publish',
    meta: agoWords(p.at),
    ...(p.can?.change ? { actions: [{ id: 'withdraw', label: 'Take it back' }] } : {}),
  }));
  const taking = live.find((p) => p.id === withdrawing);
  const options: SelectOption[] = data.targets.map((t, i) => ({
    value: String(i),
    label: t.to?.kind === 'org' ? 'The org' : (t.to?.name ?? 'A floor that’s gone'),
    ...(t.why ? { disabled: true, detail: t.why } : t.via ? { detail: `On from ${floorWords(t.from)}` } : {}),
  }));
  const chosen = data.targets[target];
  const allowed = chosen?.most ?? CONTENT_STATES.map((s) => s.id);

  return (
    <div className="folio-publish-up" data-folio-publish-up="">
      {live.length ? <Path steps={chainSteps(own, live, data.owner, here) as PathStep[]} /> : null}
      {data.owner && live.length ? <p className="folio-up-lead">{floorWords(data.owner) === 'the org' ? 'The org owns it' : `${floorWords(data.owner)} owns it`}: the highest floor it has reached decides about it now.</p> : null}
      {live.length ? (
        <>
          <List label="Where it’s been published" density="compact" noun={['floor', 'floors']} items={rows} onAction={(item) => setWithdrawing(item.id)} />
          {taking ? (
            <>
              <TextField label="Why it’s taken back" optional maxLength={500} hint="It comes off every floor it went to from there too, and goes on the record." value={why} onChange={setWhy} />
              <div className="folio-actions">
                <Button kind="danger" size="sm" busy={busy} busyLabel="Taking it back…" onPress={() => void withdraw(taking.id)}>
                  Take it off {floorWords(taking.toFloor)}
                </Button>
                <Button kind="ghost" size="sm" onPress={() => setWithdrawing(undefined)}>
                  Leave it there
                </Button>
              </div>
            </>
          ) : null}
        </>
      ) : (
        <p className="folio-up-lead">It’s only on its own floor. Publish it up and the floor above sees what it lets through, as it changes.</p>
      )}
      {!data.targets.length ? (
        <p className="folio-up-hint">Only whoever manages it can publish it up, or the leads of a floor it reached can take it further.</p>
      ) : (
        <section className="folio-up-form" aria-label="Publish it up">
          <Select
            label="Publish it to"
            options={options}
            value={target >= 0 ? String(target) : null}
            onChange={(v) => {
              setTarget(Number(v));
              fit(data, Number(v));
            }}
          />
          <CheckboxGroup
            label="Showing versions that are"
            required
            hint={chosen?.most ? `It can show no more than reached ${floorWords(chosen.from)}.` : 'New versions show as they reach these states.'}
            value={filter}
            onChange={(v) => setFilter(v as ContentState[])}
          >
            {CONTENT_STATES.filter((s) => allowed.includes(s.id)).map((s) => (
              <Checkbox key={s.id} value={s.id}>
                {s.name}
              </Checkbox>
            ))}
          </CheckboxGroup>
          <TextField label="A word about it" optional multiline maxLength={500} hint="It goes with the notification." value={said} onChange={setSaid} />
          <div className="folio-actions">
            <Button
              kind="primary"
              size="sm"
              disabled={!chosen || Boolean(chosen.why) || !filter.length}
              reason={!chosen || chosen.why ? 'Choose a floor it can go to first.' : 'Choose at least one state to show.'}
              busy={busy}
              busyLabel="Publishing…"
              onPress={() => void publish()}
            >
              Publish to {floorWords(chosen?.to)}
            </Button>
          </div>
          <p className="folio-up-hint">Only up, never sideways. The highest floor it reaches owns it, and each person sees it in one place: the highest floor that shows it to them.</p>
        </section>
      )}
      <p className="folio-note" role="status">
        {note}
      </p>
    </div>
  );
}
