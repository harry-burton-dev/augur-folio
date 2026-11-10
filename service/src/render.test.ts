import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { capped, escapeMarkdown, htmlToMarkdown, kindOf, paragraphs, render } from './render.ts';

const fixture = (name: string) => new URL(`./fixtures/${name}`, import.meta.url).pathname;
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Renders a fixture, or some text written as `filename`, the way the worker does. */
const rendered = async (filename: string, mediaType: string, body?: string) => {
  const dir = await mkdtemp(join(tmpdir(), 'render-test-'));
  dirs.push(dir);
  const file = join(dir, 'original');
  if (body === undefined) await copyFile(fixture(filename), file);
  else await writeFile(file, body);
  return render({ file, filename, mediaType, dir, picturePath: (name) => `v1/documents/d1/versions/1/pictures/${name}` });
};

describe('reader copies without ML models', () => {
  it('tells a file’s kind by its type, or its name when the browser didn’t say', () => {
    expect(kindOf('plan.PDF', 'application/octet-stream')).toBe('pdf');
    expect(kindOf('x', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('word');
    expect(kindOf('notes.md', 'application/octet-stream')).toBe('markdown');
    expect(kindOf('chart.xlsx', 'application/octet-stream')).toBeUndefined();
  });

  it('reads a PDF’s words into paragraphs, with a picture of its first page', async () => {
    const out = await rendered('plan.pdf', 'application/pdf');
    expect(out).toMatchObject({ kind: 'ready', pages: 2, pictures: [] });
    if (out.kind !== 'ready') return;
    expect(out.markdown).toBe('Harbour plan The quay is rebuilt in spring.\n\nSecond page about dredging.');
    expect(out.text).toContain('dredging');
    // A PNG, from pdftoppm.
    expect(out.thumbnail?.subarray(1, 4).toString()).toBe('PNG');
  });

  it('shows a PDF with no words in it, as a scan, as pictures of its pages', async () => {
    const out = await rendered('scan.pdf', 'application/pdf');
    expect(out).toMatchObject({ kind: 'ready', text: '', markdown: '![Page 1](v1/documents/d1/versions/1/pictures/page-1.png)', pictures: [{ name: 'page-1.png', contentType: 'image/png' }] });
  });

  it('reads a Word document with its headings and pictures', async () => {
    const out = await rendered('timetable.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(out).toMatchObject({ kind: 'ready', pictures: [{ name: '1.png', contentType: 'image/png' }] });
    if (out.kind !== 'ready') return;
    expect(out.markdown).toContain('# Ferry timetable');
    expect(out.markdown).toContain('Boats leave the pier every hour');
    expect(out.markdown).toContain('](v1/documents/d1/versions/1/pictures/1.png)');
    expect(out.text).toContain('Ferry timetable');
  });

  it('keeps Markdown as written, and a web page’s words without its markup', async () => {
    expect(await rendered('notes.md', 'text/markdown', '# Notes\n\n- one')).toMatchObject({ kind: 'ready', markdown: '# Notes\n\n- one' });
    const html = '<html><head><title>x</title><script>alert(1)</script></head><body><h2>Tides &amp; times</h2><p>High at <b>6</b>.</p><ul><li>Low at 12</li></ul></body></html>';
    expect(htmlToMarkdown(html)).toBe('## Tides & times\n\nHigh at 6.\n\n- Low at 12');
  });

  it('says why a file has no reader copy', async () => {
    expect(await rendered('budget.xlsx', 'application/vnd.ms-excel', 'x')).toEqual({ kind: 'none', why: expect.stringContaining('a .xlsx file') });
    expect(await rendered('old.doc', 'application/msword', 'x')).toEqual({ kind: 'none', why: expect.stringContaining('.docx') });
  });

  it('rejects a file a tool can’t read, so the worker can try again', async () => {
    await expect(rendered('broken.pdf', 'application/pdf', 'not a pdf')).rejects.toThrow(/pdfinfo/);
  });

  it('keeps plain words plain, and cuts a copy too long to show', () => {
    expect(escapeMarkdown('# not a heading *or* [link]')).toBe('\\# not a heading \\*or\\* \\[link\\]');
    expect(paragraphs('one\ntwo\n\nthree-\nfour')).toEqual(['one two', 'threefour']);
    expect(capped('aaa\n\nbbb\n\nccc', 9)).toMatch(/^aaa\n\nbbb\n\n\*The rest is too long/);
  });
});
