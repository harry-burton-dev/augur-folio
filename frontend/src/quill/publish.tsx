import { Button, Icon, List, Select, State, TextField, relativeTime, type ListItem, type SelectOption } from '@augur/app-kit';
import { useCallback, useEffect, useState } from 'react';
import type { FolioApi, Principal, Publication, Publications } from '../api.js';
import { agoWords } from '../folio-publish.js';
import { audienceWords, whoWords } from '../words.js';
import { Audience, type Chosen } from './audience.js';

/** How a publication ended, or that it's out. */
const endWords = (p: Publication<Principal>) =>
  !p.ended ? 'Out now' : p.ended.as === 'withdrawn' ? `Withdrawn ${agoWords(p.ended.at)}${p.ended.reason ? `: ${p.ended.reason}` : ''}` : `Replaced ${agoWords(p.ended.at)}`;

/** Who a new publication goes to at first: who the one out went to, or the floor's team and those below it. */
const startWith = (history: Publications, floor: Principal): Chosen[] => {
  const out = history.publications.find((p) => !p.ended);
  if (out) return out.audience.map((p) => ({ principal: p.principal, name: whoWords(p) }));
  if (floor.kind === 'tree') return [{ principal: floor.principal, name: whoWords(floor) }];
  if (floor.kind === 'org' && history.can.publishToOrg) return [{ principal: 'org', name: 'Everyone in the org' }];
  return [];
};

export interface PublishProps {
  api: FolioApi;
  library: string;
  document: string;
  /** The document's version numbers, newest first. */
  versions: number[];
  /** A series' issue: only issues still go out one version at a time; anything else is published up the floors. */
  issue?: boolean;
  /** A version went out or was taken back. */
  onPublished?: () => void;
}

/**
 * Publishing a document: what's out now and to whom, putting a version out
 * to teams or the whole org (replacing what was out), taking it back, and
 * every time it was published before. Sits inside a dialog.
 */
export function Publish({ api, library, document, versions, issue = false, onPublished }: PublishProps) {
  const [history, setHistory] = useState<Publications>();
  const [floor, setFloor] = useState<Principal>();
  const [failure, setFailure] = useState('');
  const [version, setVersion] = useState(versions[0] ?? 0);
  const [chosen, setChosen] = useState<Chosen[]>([]);
  const [withdrawing, setWithdrawing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [said, setSaid] = useState('');
  const [why, setWhy] = useState('');

  const load = useCallback(async () => {
    setFailure('');
    try {
      const [h, access] = await Promise.all([api.publications(library, document), api.access(library, { document })]);
      setHistory(h);
      setFloor(access.floor);
      setChosen(startWith(h, access.floor));
    } catch (err) {
      setFailure((err as Error).message);
    }
  }, [api, library, document]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!versions.includes(version)) setVersion(versions[0] ?? 0);
  }, [versions, version]);

  const act = async (run: () => Promise<string>) => {
    setBusy(true);
    try {
      setNote(await run());
      setHistory(await api.publications(library, document));
      onPublished?.();
    } catch (err) {
      setNote((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const publish = () =>
    act(async () => {
      const out = await api.publish(library, document, version, chosen.map((c) => c.principal), said.trim() || undefined);
      setSaid('');
      return `Version ${out.version} is out to ${audienceWords(out.audience)}.`;
    });
  const withdraw = () =>
    act(async () => {
      const back = await api.withdraw(library, document, why.trim() || undefined);
      setWithdrawing(false);
      setWhy('');
      return `Version ${back.version} is withdrawn: only those who could see it before can read it now.`;
    });

  if (failure) return <State kind="error" heading="Couldn’t see how it’s published" body={failure} action="Try again" onAction={() => void load()} />;
  if (!history) return <State kind="loading" heading="Seeing how it’s published" />;
  const out = history.publications.find((p) => !p.ended);
  const before: ListItem[] = history.publications.map((p) => ({
    id: p.id,
    title: `Version ${p.version} to ${audienceWords(p.audience)}`,
    detail: endWords(p),
    icon: p.ended ? (p.ended.as === 'withdrawn' ? 'withdraw' : 'document') : 'publish',
    meta: relativeTime(p.publishedAt),
  }));
  const versionOptions: SelectOption[] = versions.map((n, i) => ({ value: String(n), label: `Version ${n}${i === 0 ? ', the newest' : ''}`, ...(out?.version === n ? { detail: 'Out now' } : {}) }));
  const own = floor?.kind === 'person';

  return (
    <div className="folio-publish" data-folio-publish="">
      {out ? (
        <div className="folio-publish-out">
          <p className="folio-publish-lead">
            <Icon name="publish" size={20} /> Version {out.version} went out to {audienceWords(out.audience)} {agoWords(out.publishedAt)}.
          </p>
          {out.note ? <p className="folio-publish-said">“{out.note}”</p> : null}
          {history.can.publish ? (
            withdrawing ? (
              <>
                <TextField label="Why it’s withdrawn" optional maxLength={500} hint="It goes on the record with it." value={why} onChange={setWhy} />
                <div className="folio-actions">
                  <Button kind="danger" size="sm" busy={busy} busyLabel="Withdrawing…" onPress={() => void withdraw()}>
                    Withdraw version {out.version}
                  </Button>
                  <Button kind="ghost" size="sm" onPress={() => setWithdrawing(false)}>
                    Keep it out
                  </Button>
                </div>
              </>
            ) : (
              <div className="folio-actions">
                <Button kind="secondary" size="sm" onPress={() => setWithdrawing(true)}>
                  Withdraw
                </Button>
              </div>
            )
          ) : null}
        </div>
      ) : (
        <p className="folio-publish-lead">It hasn’t been published: only those who can see the collection, or it’s been shared with, can read it.</p>
      )}
      {!history.can.publish ? null : !issue ? (
        <p className="folio-publish-hint">A document is published up the floors now: close this and choose Publish up the floors, and which states it shows. What went out before keeps reading as it did until Artifacts moves it there.</p>
      ) : (
        <section className="folio-publish-form" aria-label="Publish a version">
          <Select label="Version" options={versionOptions} value={String(version)} onChange={(v) => setVersion(Number(v))} />
          <Audience
            api={api}
            chosen={chosen}
            onChange={setChosen}
            org={history.can.publishToOrg}
            empty={own && !history.can.publishToOrg ? 'Publishing from your own floor needs the publisher role. Share it instead.' : 'Add a team, or the whole org.'}
          />
          <TextField label="A word about it" optional multiline maxLength={500} hint="It goes with the notification, and stays with the version." value={said} onChange={setSaid} />
          <div className="folio-actions">
            <Button
              kind="primary"
              size="sm"
              disabled={!chosen.length || !version}
              reason={!version ? 'There’s no version to publish yet.' : 'Choose who to publish it to first.'}
              busy={busy}
              busyLabel="Publishing…"
              onPress={() => void publish()}
            >
              {!out ? `Publish version ${version}` : out.version === version ? 'Publish it again' : `Publish version ${version} instead`}
            </Button>
          </div>
          <p className="folio-publish-hint">Everyone it goes to can read this version from their own floor, and is told it’s there. Only this version: not the others, nor the rest of the library.</p>
        </section>
      )}
      {history.publications.length ? <List label="Published before" density="compact" noun={['time', 'times']} items={before} /> : null}
      <p className="folio-note" role="status">
        {note}
      </p>
    </div>
  );
}
