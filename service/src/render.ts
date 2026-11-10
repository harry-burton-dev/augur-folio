import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import mammoth from 'mammoth';

/**
 * Turns a file into a reader copy without ML models (the spec's D3): Markdown for the kit's reader, its
 * plain text for Find, a picture of the first page and the pictures it holds. PDFs go through Poppler
 * (`pdftotext`, `pdftoppm`, `pdfinfo`), Word through Mammoth; Markdown is read as written, HTML and plain
 * text are carried over as text. Nothing here reaches the network.
 */

export type FileKind = 'pdf' | 'word' | 'markdown' | 'html' | 'text' | 'image';

export interface Picture {
  name: string;
  contentType: string;
  body: Buffer;
}

export type Rendered =
  | { kind: 'ready'; markdown: string; text: string; pages?: number; thumbnail?: Buffer; pictures: Picture[] }
  | { kind: 'none'; why: string };

export interface RenderInput {
  /** The original, on disk. */
  file: string;
  filename: string;
  mediaType: string;
  /** A folder of its own to work in. */
  dir: string;
  /** The path under the app's API a picture of this version is fetched at, for the Markdown to name. */
  picturePath: (name: string) => string;
  /** How long each tool may run. */
  timeoutMs?: number;
}

/** Past this, a reader copy stops and says the rest is in the original. */
export const MAX_READER_CHARS = 2 * 1024 * 1024;
/** A PDF with no text in it (a scan) is shown as pictures of its pages, up to this many. */
export const MAX_PAGE_PICTURES = 40;
/** A picture uploaded as a document is shown as it is, up to this size. */
export const MAX_PICTURE_BYTES = 25 * 1024 * 1024;
const THUMBNAIL_PIXELS = 480;
const PAGE_DPI = 110;

const SHOWN_PICTURES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

const extensionOf = (filename: string) => /\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1]?.toLowerCase();

/** What kind of file it is, from its type or, when the browser didn't say, its name. */
export const kindOf = (filename: string, mediaType: string): FileKind | undefined => {
  const type = mediaType.toLowerCase();
  const ext = extensionOf(filename);
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || ext === 'docx') return 'word';
  if (type === 'text/markdown' || ext === 'md' || ext === 'markdown') return 'markdown';
  if (type === 'text/html' || ext === 'html' || ext === 'htm') return 'html';
  if (SHOWN_PICTURES[type] || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext ?? '')) return 'image';
  if (type.startsWith('text/') || ext === 'txt' || ext === 'csv') return 'text';
  return undefined;
};

/** Why a file has no reader copy, for whoever opens it. */
export const noReaderCopy = (filename: string, mediaType: string) => {
  const ext = extensionOf(filename);
  if (ext === 'doc') return 'Artifacts reads Word documents saved as .docx, not the older .doc. Save it as .docx and add it as a new version, or download the original to open it.';
  return `Artifacts can’t show ${ext ? `a .${ext} file` : `a file of this kind (${mediaType})`} here. Download the original to open it.`;
};

/** Runs a tool and answers what it wrote, or rejects with what it said. */
const run = (cmd: string, args: string[], timeoutMs: number) =>
  new Promise<string>((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' } }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(new Error(`${cmd}: ${(stderr || err.message).trim().slice(0, 500)}`), { stderr: String(stderr ?? ''), killed: err.killed }));
      else resolve(stdout);
    });
  });

/** Marks that would make plain words into Markdown, escaped. */
export const escapeMarkdown = (line: string) =>
  line
    .replace(/([\\`*_[\]<>|~])/g, '\\$1')
    .replace(/^(\s*)([#+=-]|\d+[.)])(?=\s|$)/, '$1\\$2')
    .replace(/^(\s*)>/, '$1\\>');

/** Plain text as Markdown paragraphs: a blank line between paragraphs, the lines of each joined up. */
export const paragraphs = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((p) =>
      p
        // A word broken over a line by a hyphen is one word again.
        .replace(/(\p{L})-\n(\p{Ll})/gu, '$1$2')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .join(' '),
    )
    .filter(Boolean)
    .map(escapeMarkdown);

/** Cuts a reader copy that is too long at a paragraph, and says the rest is in the original. */
export const capped = (markdown: string, max = MAX_READER_CHARS) => {
  if (markdown.length <= max) return markdown;
  const cut = markdown.lastIndexOf('\n\n', max);
  return `${markdown.slice(0, cut > 0 ? cut : max)}\n\n*The rest is too long to show here. Download the original to read all of it.*\n`;
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', mdash: '—', ndash: '–', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”' };

const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[e.toLowerCase()] ?? whole;
  });

/**
 * A web page's words as Markdown: its headings, paragraphs and list items kept, everything else as text.
 * The kit's reader shows any markup as text, so this only has to read well, not be safe.
 */
export const htmlToMarkdown = (html: string) => {
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const blocks = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, n: string, words: string) => `\n\n\uE000${n}${words}\n\n`)
    .replace(/<li\b[^>]*>/gi, '\n\n\uE001')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section|article|header|footer|main|aside|nav|ul|ol|li|table|tr|blockquote|pre|figure|figcaption|dl|dt|dd)\b[^>]*>/gi, '\n\n')
    .replace(/<\/t[dh]\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '');
  return blocks
    .split(/\n[ \t]*\n+/)
    .map((b) => decodeEntities(b).replace(/\s+/g, ' ').trim())
    .filter((b) => b.replace(/[\uE000\uE001\d]/g, '').trim())
    .map((b) => {
      if (b.startsWith('\uE000')) return `${'#'.repeat(Number(b[1]))} ${escapeMarkdown(b.slice(2).trim())}`;
      if (b.startsWith('\uE001')) return `- ${escapeMarkdown(b.slice(1).trim())}`;
      return escapeMarkdown(b);
    })
    .join('\n\n');
};

/** Markdown's words without its marks, for Find. */
export const markdownText = (markdown: string) =>
  markdown
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[\\`*_#>|~[\]-]+/g, ' ');

const readText = async (file: string) => {
  const { size } = await stat(file);
  const raw = await readFile(file);
  // Text past the reader's limit is cut anyway; reading it all would only use memory.
  return new TextDecoder('utf-8').decode(size > MAX_READER_CHARS * 2 ? raw.subarray(0, MAX_READER_CHARS * 2) : raw).replace(/^\uFEFF/, '');
};

const PASSWORD = /password|encrypted/i;

const renderPdf = async ({ file, dir, picturePath, timeoutMs }: Required<Omit<RenderInput, 'filename' | 'mediaType'>>): Promise<Rendered> => {
  let info: string;
  try {
    info = await run('pdfinfo', [file], timeoutMs);
  } catch (err) {
    if (PASSWORD.test((err as { stderr?: string }).stderr ?? '')) return { kind: 'none', why: 'It’s protected by a password, so Artifacts can’t read it. Download the original to open it.' };
    throw err;
  }
  const pages = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? 0) || undefined;
  const text = await run('pdftotext', ['-enc', 'UTF-8', '-eol', 'unix', file, '-'], timeoutMs);
  await run('pdftoppm', ['-png', '-f', '1', '-l', '1', '-scale-to', String(THUMBNAIL_PIXELS), '-singlefile', file, join(dir, 'thumbnail')], timeoutMs);
  const thumbnail = await readFile(join(dir, 'thumbnail.png'));
  const words = text.split('\f').flatMap(paragraphs);
  if (words.length) return { kind: 'ready', markdown: capped(words.join('\n\n')), text, ...(pages ? { pages } : {}), thumbnail, pictures: [] };
  // No text in it, as in a scan: its pages as pictures, since reading the words off them would take a model.
  const last = Math.min(pages ?? 1, MAX_PAGE_PICTURES);
  await run('pdftoppm', ['-png', '-r', String(PAGE_DPI), '-f', '1', '-l', String(last), file, join(dir, 'page')], timeoutMs * 2);
  const pictures: Picture[] = [];
  const width = String(last).length;
  for (let n = 1; n <= last; n++) {
    // pdftoppm pads the page number to the width of the last page's.
    const name = `page-${String(n).padStart(width, '0')}.png`;
    pictures.push({ name: `page-${n}.png`, contentType: 'image/png', body: await readFile(join(dir, name)) });
  }
  const markdown = pictures.map((p, i) => `![Page ${i + 1}](${picturePath(p.name)})`);
  if ((pages ?? 0) > last) markdown.push(`*Pages ${last + 1} to ${pages} are only in the original. Download it to see them.*`);
  return { kind: 'ready', markdown: markdown.join('\n\n'), text: '', ...(pages ? { pages } : {}), thumbnail, pictures };
};

// Mammoth escapes a picture's address as Markdown text, so it is given a plain word to stand in for one.
const STAND_IN = 'augurpicture';
const UNSHOWN = 'augurunshown';

const renderWord = async ({ file, picturePath }: Pick<RenderInput, 'file' | 'picturePath'>): Promise<Rendered> => {
  const pictures: Picture[] = [];
  const convertImage = mammoth.images.imgElement(async (image) => {
    const ext = SHOWN_PICTURES[image.contentType];
    if (!ext) return { src: UNSHOWN };
    pictures.push({ name: `${pictures.length + 1}.${ext}`, contentType: image.contentType, body: await image.readAsBuffer() });
    return { src: `${STAND_IN}${pictures.length}` };
  });
  // Mammoth's Markdown writer is kept, though its readme no longer offers it: the kit's reader takes Markdown.
  const toMarkdown = (mammoth as unknown as { convertToMarkdown: typeof mammoth.convertToHtml }).convertToMarkdown;
  const [md, raw] = await Promise.all([toMarkdown({ path: file }, { convertImage, externalFileAccess: false }), mammoth.extractRawText({ path: file })]);
  const markdown = md.value
    .replace(new RegExp(`\\]\\(${STAND_IN}(\\d+)\\)`, 'g'), (whole, n: string) => {
      const picture = pictures[Number(n) - 1];
      return picture ? `](${picturePath(picture.name)})` : whole;
    })
    .replace(new RegExp(`!\\[([^\\]]*)\\]\\(${UNSHOWN}\\)`, 'g'), (_m, alt: string) => `*(A picture that can’t be shown here${alt ? `: ${alt}` : ''}. It’s in the original.)*`)
    .trim();
  return { kind: 'ready', markdown: capped(markdown), text: raw.value, pictures };
};

/** Makes the reader copy of one file. Rejects when a tool fails, so the worker can try again. */
export const render = async (input: RenderInput): Promise<Rendered> => {
  const timeoutMs = input.timeoutMs ?? 120_000;
  const kind = kindOf(input.filename, input.mediaType);
  switch (kind) {
    case 'pdf':
      return renderPdf({ file: input.file, dir: input.dir, picturePath: input.picturePath, timeoutMs });
    case 'word':
      return renderWord(input);
    case 'markdown': {
      const markdown = await readText(input.file);
      return { kind: 'ready', markdown: capped(markdown), text: markdownText(markdown), pictures: [] };
    }
    case 'html': {
      const markdown = htmlToMarkdown(await readText(input.file));
      return { kind: 'ready', markdown: capped(markdown), text: markdownText(markdown), pictures: [] };
    }
    case 'text': {
      const text = await readText(input.file);
      return { kind: 'ready', markdown: capped(paragraphs(text).join('\n\n')), text, pictures: [] };
    }
    case 'image': {
      if ((await stat(input.file)).size > MAX_PICTURE_BYTES) return { kind: 'none', why: 'This picture is too large to show here. Download the original to see it.' };
      const contentType = SHOWN_PICTURES[input.mediaType.toLowerCase()] ? input.mediaType.toLowerCase() : `image/${extensionOf(input.filename) === 'jpg' ? 'jpeg' : extensionOf(input.filename)}`;
      const name = `1.${SHOWN_PICTURES[contentType] ?? 'png'}`;
      return { kind: 'ready', markdown: `![${escapeMarkdown(input.filename)}](${input.picturePath(name)})`, text: '', pictures: [{ name, contentType, body: await readFile(input.file) }] };
    }
    default:
      return { kind: 'none', why: noReaderCopy(input.filename, input.mediaType) };
  }
};
