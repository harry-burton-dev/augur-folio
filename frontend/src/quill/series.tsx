import { Button, Dialog, DropZone, Heading, Icon, List, Select, State, Surface, TagPicker, TextField, Toggle, relativeTime, type ListItem } from '@augur/app-kit';
import { useCallback, useEffect, useState } from 'react';
import { ACCEPT, MAX_UPLOAD_MB, type Cadence, type FolioApi, type FolioDocument, type OpenLibrary, type Principal, type SeriesView } from '../api.js';
import { audienceWords, CADENCE_OPTIONS, CADENCE_WORDS, issueDetail, nameCheck, nextWords, tagOptions, whoWords } from '../words.js';
import { Audience, type Chosen } from './audience.js';

/** A series with its audience named, as its own call gives it. */
export type LoadedSeries = Omit<SeriesView, 'audience'> & { audience: Principal[] };

export interface SeriesPageProps {
  api: FolioApi;
  series: string;
  onRead: (library: string, document: string) => void;
  onEdit: (series: LoadedSeries) => void;
  onDelete: (series: LoadedSeries) => void;
  /** After an issue goes up, so what shows it can catch up. */
  onAdded?: () => void;
}

/**
 * A series on its own page: how often it comes out and who its issues go to,
 * the issue it expects next and the way to add it (one file, everything else
 * from the series), following it, and its issues, newest first.
 */
export function SeriesPage({ api, series, onRead, onEdit, onDelete, onAdded }: SeriesPageProps) {
  const [run, setRun] = useState<LoadedSeries>();
  const [issues, setIssues] = useState<FolioDocument[]>([]);
  const [failure, setFailure] = useState('');
  const [adding, setAdding] = useState(false);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setFailure('');
    try {
      const [loaded, { documents }] = await Promise.all([api.series(series), api.issues(series)]);
      setRun(loaded);
      setIssues(documents);
    } catch (err) {
      setFailure((err as Error).message);
    }
  }, [api, series]);
  useEffect(() => void load(), [load]);

  const add = async (file: File | undefined) => {
    if (!run || !file) return;
    setAdding(true);
    setNote('');
    try {
      const issue = await api.addIssue(run.library, run.id, file);
      setNote(issue.draft ? `Added ${issue.title} as a draft. ${issue.draft}` : issue.state === 'published' ? `${issue.title} is out to ${audienceWords(run.audience)}.` : `Added ${issue.title}.`);
      onAdded?.();
      await load();
    } catch (err) {
      setNote(`Couldn’t add ${file.name}: ${(err as Error).message}`);
    } finally {
      setAdding(false);
    }
  };

  if (failure) return <State kind="error" heading="Couldn’t open the series" body={failure} action="Try again" onAction={() => void load()} />;
  if (!run) return <State kind="loading" heading="Opening the series" />;
  const rows: ListItem[] = issues.map((d) => ({ id: d.id, title: d.title, icon: d.state === 'published' ? 'publish' : 'document', detail: issueDetail(d), meta: relativeTime(d.createdAt) }));
  const goesTo = run.audience.length ? `Each issue goes out to ${audienceWords(run.audience)} as it’s added.` : 'Issues stay drafts until someone publishes them.';
  return (
    <div className="folio-series" data-folio-series={run.id}>
      <div className="folio-series-head">
        <Heading eyebrow={`A series in ${run.libraryName}`} heading={run.name} summary={run.description || undefined} />
        {run.can.manage ? (
          <div className="folio-series-actions">
            <Button kind="tertiary" size="sm" onPress={() => onEdit(run)}>
              Change it
            </Button>
            {run.issues ? null : (
              <Button kind="tertiary" size="sm" onPress={() => onDelete(run)}>
                Remove
              </Button>
            )}
          </div>
        ) : null}
      </div>
      <div className="folio-series-facts">
        <p>
          <Icon name="series" size={18} />
          {CADENCE_WORDS[run.cadence]}. {goesTo}
        </p>
        <p data-late={run.next.overdue ? '' : undefined}>
          <Icon name={run.next.overdue ? 'warning' : 'clock'} size={18} />
          {nextWords(run)}
        </p>
      </div>
      <Toggle
        label="Tell me of each new issue"
        hint="You’re told when one is published to you."
        checked={run.following}
        onChange={(on) => api.follow(run.id, on).then(() => setRun({ ...run, following: on }))}
      />
      {run.can.addIssue ? (
        <DropZone
          heading={`Drop the ${run.cadence === 'adhoc' ? 'next issue' : `issue for ${run.next.period}`} here`}
          hint={`It’s named, tagged${run.audience.length && run.can.publish ? ' and published' : ''} for you. PDF, Word, HTML, Markdown or text, up to ${MAX_UPLOAD_MB} MB.`}
          action="Choose a file"
          accept={ACCEPT}
          multiple={false}
          busy={adding}
          onFiles={(files) => void add(files[0])}
          onReject={() => setNote('Artifacts takes PDF, Word (.docx), HTML, Markdown and plain text.')}
        />
      ) : null}
      <Surface>
        <List
          label={`Issues of ${run.name}`}
          density="compact"
          noun={['issue', 'issues']}
          items={rows}
          empty={run.can.addIssue ? 'No issues yet. Drop the first one above.' : 'No issues you can read yet.'}
          onOpen={(item) => onRead(run.library, item.id)}
        />
      </Surface>
      <p className="folio-picker-note" role="status">
        {adding ? 'Adding the issue…' : note}
      </p>
    </div>
  );
}

export interface SeriesDialogProps {
  api: FolioApi;
  /** The library a new series goes in, with its tags and series. */
  library: OpenLibrary;
  /** The series to change; none for a new one. */
  series?: LoadedSeries;
  /** The whole org may get its issues. */
  org?: boolean;
  onClose: () => void;
  onSaved: (series: SeriesView) => void;
}

/** Making a series, or changing one: its name, what it's for, how often, the tags and audience each issue starts with. */
export function SeriesDialog({ api, library, series, org, onClose, onSaved }: SeriesDialogProps) {
  const [audience, setAudience] = useState<Chosen[]>(series ? series.audience.map((p) => ({ principal: p.principal, name: whoWords(p) })) : []);
  const taken = library.series.filter((r) => r.id !== series?.id).map((r) => r.name);
  const list = (v: string | undefined) => (v ? v.split(',').filter(Boolean) : []);
  return (
    <Dialog
      open
      onClose={onClose}
      eyebrow={series ? 'Series' : library.name}
      heading={series ? `Change ${series.name}` : 'New series'}
      summary="A run of documents that comes out on a cadence, such as a weekly report. Each new issue takes its name, tags and audience from here."
      actionLabel={series ? 'Save' : 'Make it'}
      busyLabel={series ? 'Saving…' : 'Making…'}
      onSubmit={async (values) => {
        const fields = { name: (values.name ?? '').trim(), description: (values.description ?? '').trim(), cadence: (values.cadence || 'weekly') as Cadence, tags: list(values.tags), audience: audience.map((a) => a.principal) };
        onSaved(series ? await api.updateSeries(series.library, series.id, fields) : await api.createSeries(library.id, fields));
      }}
      fields={
        <>
          <TextField name="name" label="Name" required maxLength={80} defaultValue={series?.name ?? ''} validate={nameCheck(taken, 'series')} />
          <TextField name="description" label="What it’s for" optional multiline maxLength={500} defaultValue={series?.description ?? ''} />
          <Select name="cadence" label="Comes out" options={CADENCE_OPTIONS} defaultValue={series?.cadence ?? 'weekly'} hint="Weekly, monthly and quarterly issues each have a period, and its owner is reminded when one is late." />
          <TagPicker name="tags" label="Tags each issue starts with" optional placeholder="None" options={tagOptions(library.tags)} defaultValue={series?.tags ?? []} />
          <Audience api={api} label="Who each issue goes to" org={org} chosen={audience} onChange={setAudience} empty="No one: issues stay drafts until someone publishes them." />
        </>
      }
    />
  );
}
