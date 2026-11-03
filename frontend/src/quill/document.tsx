import { Button, Dialog, DropZone, List, Note, Select, Tag, TagPicker, TextField, relativeTime, type ListItem, type SelectOption } from '@augur/app-kit';
import { useState } from 'react';
import { ACCEPT, sizeWords, type FolioApi, type OpenDocument, type OpenLibrary, type Tag as FolioTag } from '../api.js';
import { documentLine, folderTrail, readerWords } from '../places.js';
import { tagOptions } from '../words.js';

export interface DocumentDialogProps {
  api: FolioApi;
  doc: OpenDocument;
  /** Its collection, when the person can open it: for its tags and folders. */
  library?: OpenLibrary;
  onClose: () => void;
  /** The document changed: read it again. */
  onChanged: (doc: OpenDocument) => void;
  /** The collection's tags changed (one was added). */
  onTags: (tags: FolioTag[]) => void;
  /** It was deleted. */
  onDeleted: () => void;
  onDownload: (version: number) => void;
  onRetry: (version: number) => void;
}

/** Every folder in the collection, by where it is, for moving a document. */
export const folderOptions = (lib: OpenLibrary): SelectOption[] => [
  { value: '', label: `${lib.name} (the top)` },
  ...lib.folders
    .map((f) => ({ value: f.id, label: folderTrail(lib.folders, f.id).map((t) => t.name).join(' / ') }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })),
];

/**
 * Changing a document: its tags, its versions (download, or try the reader
 * copy again), a new version dropped in, and renaming, moving or deleting it.
 */
export function DocumentDialog({ api, doc, library, onClose, onChanged, onTags, onDeleted, onDownload, onRetry }: DocumentDialogProps) {
  const [step, setStep] = useState<'about' | 'edit' | 'delete'>('about');
  const [note, setNote] = useState('');
  const [adding, setAdding] = useState(false);
  const tags = library?.tags ?? [];
  const reread = () => api.document(doc.library, doc.id).then(onChanged);

  const retag = async (next: string[]) => {
    try {
      const tagged = await api.setTags(doc.library, doc.id, next);
      onChanged({ ...doc, tags: tagged.tags });
    } catch (err) {
      setNote((err as Error).message);
    }
  };
  const newTag = async (name: string) => {
    if (!library) return;
    try {
      const tag = await api.createTag(library.id, name);
      onTags([...library.tags, tag].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
      await retag([...doc.tags, tag.id]);
    } catch (err) {
      setNote((err as Error).message);
    }
  };
  const newVersion = async (files: File[]) => {
    const f = files[0];
    if (!f) return;
    setAdding(true);
    try {
      await api.addVersion(doc.library, doc.id, f);
      const fresh = await api.document(doc.library, doc.id);
      onChanged(fresh);
      setNote(`Added version ${fresh.latest.number} of ${fresh.title}.`);
    } catch (err) {
      setNote(`Couldn’t add ${f.name}: ${(err as Error).message}`);
    } finally {
      setAdding(false);
    }
  };

  if (step === 'edit')
    return (
      <Dialog
        open
        onClose={() => setStep('about')}
        eyebrow="Document"
        heading={`Rename or move ${doc.title}`}
        actionLabel="Save"
        busyLabel="Saving…"
        onSubmit={async (v) => {
          await api.updateDocument(doc.library, doc.id, { title: v.title!.trim(), ...(library ? { folder: v.folder || null } : {}) });
          await reread();
        }}
        fields={
          <>
            <TextField name="title" label="Title" required maxLength={200} defaultValue={doc.title} autoFocus />
            {library ? <Select name="folder" label="Folder" options={folderOptions(library)} defaultValue={doc.folder ?? ''} /> : null}
          </>
        }
      />
    );
  if (step === 'delete')
    return (
      <Dialog
        open
        danger
        onClose={(done) => (done ? onDeleted() : setStep('about'))}
        eyebrow="Document"
        heading={`Delete ${doc.title}?`}
        actionLabel="Delete"
        busyLabel="Deleting…"
        onSubmit={() => api.deleteDocument(doc.library, doc.id).then(() => undefined)}
      >
        <p>
          It leaves this library, with all {doc.versions.length} {doc.versions.length === 1 ? 'version' : 'versions'}. The record of it stays in the audit log.
        </p>
      </Dialog>
    );

  const versions: ListItem[] = doc.versions.map((v) => ({
    id: String(v.number),
    title: `Version ${v.number}`,
    icon: 'document',
    detail: `${v.filename} · ${sizeWords(v.size)} · ${readerWords(v.reader)}`,
    meta: relativeTime(v.createdAt),
    actions: [{ id: 'download', label: 'Download' }, ...(v.reader.state === 'failed' && doc.can.change ? [{ id: 'retry', label: 'Try again' }] : [])],
  }));
  const where = folderTrail(library?.folders ?? [], doc.folder).at(-1)?.name ?? library?.name ?? 'Document';
  return (
    <Dialog open light size="read" onClose={onClose} eyebrow={where} heading={doc.title} summary={documentLine(doc)} cancelLabel="Close">
      <div className="folio-document-dialog">
        {doc.can.change ? (
          <TagPicker label="Tags" placeholder="Add a tag" options={tagOptions(tags)} value={doc.tags} onChange={(next) => void retag(next)} onCreate={library?.can.addTags ? (name) => void newTag(name) : undefined} />
        ) : doc.tags.length ? (
          <div className="folio-tags" aria-label="Tags">
            {doc.tags.map((t) => {
              const tag = tags.find((x) => x.id === t);
              return tag ? <Tag key={t} quiet label={tag.name} icon={tag.library ? undefined : 'org'} /> : null;
            })}
          </div>
        ) : null}
        <List label="Versions" density="compact" noun={['version', 'versions']} items={versions} onAction={(item, action) => (action.id === 'retry' ? onRetry(Number(item.id)) : onDownload(Number(item.id)))} />
        {doc.versions
          .filter((v) => v.reader.state === 'failed')
          .map((v) => (
            <p key={v.number} className="folio-note">
              Version {v.number} has no reader copy. {v.reader.error ?? 'Artifacts couldn’t make one.'}
            </p>
          ))}
        {doc.can.change ? (
          <>
            <DropZone
              compact
              heading="Drop the next version here: it becomes the newest"
              action="Choose a file"
              accept={ACCEPT}
              multiple={false}
              busy={adding}
              onFiles={(files) => void newVersion(files)}
              onReject={(files) => setNote(`Artifacts can’t take ${files.map((f) => f.name).join(', ')}: it takes PDF, Word (.docx), HTML, Markdown and plain text.`)}
            />
            <Note live>{adding ? 'Adding the new version…' : note}</Note>
            <div className="folio-actions">
              <Button kind="secondary" size="sm" onPress={() => setStep('edit')}>
                Rename or move
              </Button>
              <Button kind="ghost" size="sm" onPress={() => setStep('delete')}>
                Delete
              </Button>
            </div>
          </>
        ) : note ? (
          <Note live>{note}</Note>
        ) : null}
      </div>
    </Dialog>
  );
}
