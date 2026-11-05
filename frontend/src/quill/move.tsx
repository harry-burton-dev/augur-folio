import { Button, Dialog, Lifecycle } from '@augur/app-kit';
import { useState } from 'react';
import { CONTENT_STATES, stateName, type ContentState, type OpenDocument } from '../api.js';

/** Moves past these can't be taken back by whoever made them, so they ask first. */
const ASKS_FIRST: ContentState[] = ['issued', 'retired'];

/** Why a state isn't one of the moves the service allows now. */
export const whyNot = (doc: OpenDocument, from: ContentState, to: ContentState, newest: boolean) => {
  if (!newest) return 'Only the newest version moves on.';
  if (!doc.can.change) return 'Only whoever may change it can move it on.';
  if (ASKS_FIRST.includes(to)) return 'Only whoever manages it can issue or retire it.';
  return `It can’t go straight from ${stateName(from)} to ${stateName(to)}.`;
};

/**
 * Move to…, from a document's actions: every state but the one it's in, the
 * ones it can't go to now dimmed with why. Issuing or retiring asks first.
 */
export function MoveDialog({ doc, version, onClose, onMove }: { doc: OpenDocument; version: number; onClose: () => void; onMove: (version: number, state: ContentState) => Promise<unknown> }) {
  const v = doc.versions.find((x) => x.number === version) ?? doc.latest;
  const newest = v.number === doc.latest.number;
  const allowed = new Set(newest ? (doc.can.moves ?? []) : []);
  const [asking, setAsking] = useState<ContentState>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState('');
  const move = (to: ContentState) => {
    setBusy(true);
    setFailed('');
    onMove(v.number, to).then(onClose, (err: Error) => {
      setFailed(err.message);
      setBusy(false);
    });
  };
  const pick = (to: ContentState) => (ASKS_FIRST.includes(to) ? setAsking(to) : move(to));
  const others = CONTENT_STATES.filter((s) => s.id !== v.state);

  return (
    <Dialog open light onClose={onClose} eyebrow="Move to…" heading={doc.title} summary={`Version ${v.number} is ${stateName(v.state)}.`} cancelLabel="Close">
      <div className="folio-move">
        <Lifecycle label={`Version ${v.number}`} states={CONTENT_STATES} offLine={['retired']} state={v.state} />
        {asking ? (
          <div className="folio-move-ask" role="alert">
            <p className="folio-reading-note">
              {asking === 'issued'
                ? `Issuing version ${v.number} makes it the one people go by. Only whoever manages it can move it on from there.`
                : `Retiring version ${v.number} takes it out of use. Only whoever manages it can bring it back.`}
            </p>
            <div className="folio-actions">
              <Button kind="primary" size="sm" busy={busy} busyLabel="Moving…" onPress={() => move(asking)}>
                {`Make it ${stateName(asking)}`}
              </Button>
              <Button kind="ghost" size="sm" disabled={busy} reason="It’s moving now." onPress={() => setAsking(undefined)}>
                Not now
              </Button>
            </div>
          </div>
        ) : (
          <ul className="folio-move-list" aria-label="Move it to">
            {others.map((s) => (
              <li key={s.id}>
                <Button kind="secondary" size="sm" disabled={!allowed.has(s.id) || busy} reason={busy ? 'It’s moving now.' : whyNot(doc, v.state, s.id, newest)} onPress={() => pick(s.id)}>
                  {`Make it ${s.name}`}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {failed ? (
          <p className="folio-reading-note" data-refused role="alert">
            {failed}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
