import { Button, Facts, List, State, relativeTime, type Fact, type ListItem } from '@augur/app-kit';
import { useCallback, useEffect, useState } from 'react';
import type { Brief, FolioApi, HomeGlance } from '../api.js';

/** How many documents the card names: it's a glance, not a list. */
const NAMED = 1;

export interface GlanceProps {
  api: FolioApi;
  onOpenDocument: (document: Brief) => void;
  /** To see everything published to them. */
  onOpenPublished: () => void;
}

/**
 * Artifacts' card on Home: how much has been published to the person since they
 * last looked, the newest of it, and for the floor's leads how many drafts are
 * waiting to publish.
 */
export function Glance({ api, onOpenDocument, onOpenPublished }: GlanceProps) {
  const [glance, setGlance] = useState<HomeGlance>();
  const [failure, setFailure] = useState('');
  const load = useCallback(async () => {
    setFailure('');
    try {
      setGlance(await api.home());
    } catch (err) {
      setFailure((err as Error).message);
    }
  }, [api]);
  useEffect(() => void load(), [load]);

  if (failure) return <State kind="error" heading="Couldn’t reach Artifacts" body={failure} action="Try again" onAction={() => void load()} />;
  if (!glance) return <Facts loading count={2} />;
  const { published, drafts } = glance;
  // Before they've ever looked, everything published to them is new.
  const facts: Fact[] = [{ value: published.new, label: 'New to you' }, ...(drafts ? [{ value: drafts.total, label: 'Drafts' }] : [])];
  // The newest of what's new; with nothing new, a lead's newest drafts.
  const named: (Brief & { draft?: boolean })[] = published.documents.length ? published.documents : (drafts?.documents ?? []).map((d) => ({ ...d, draft: true }));
  const rows: ListItem[] = named.slice(0, NAMED).map((d) => ({ id: d.id, title: d.title, detail: `${d.draft ? 'Draft in' : 'From'} ${d.libraryName}`, meta: relativeTime(d.at), icon: d.draft ? 'document' : 'publish' }));
  return (
    <div className="folio-glance" data-folio-glance>
      <Facts items={facts} />
      {rows.length ? (
        <List
          label="Newest"
          density="compact"
          bar={false}
          items={rows}
          onOpen={(item) => {
            const doc = named.find((d) => d.id === item.id);
            if (doc) onOpenDocument(doc);
          }}
        />
      ) : null}
      <div>
        <Button kind="secondary" size="sm" onPress={onOpenPublished}>
          Published to you
        </Button>
      </div>
    </div>
  );
}
