import { describe, it, expect } from 'vitest';
import { markdownToAdf, type AdfDoc, type AdfNode } from './adf.js';
import { BUG_REPORT_MARKDOWN } from './fixtures.js';

/** Depth-first walk over every node in the document. */
function walk(doc: AdfDoc): AdfNode[] {
  const out: AdfNode[] = [];
  const visit = (nodes: AdfNode[]): void => {
    for (const node of nodes) {
      out.push(node);
      if (node.content) visit(node.content);
    }
  };
  visit(doc.content);
  return out;
}

const nodesOfType = (doc: AdfDoc, type: string): AdfNode[] => walk(doc).filter((n) => n.type === type);

/** All text in document order — used to assert nothing was dropped. */
const allText = (doc: AdfDoc): string =>
  walk(doc)
    .filter((n) => n.type === 'text')
    .map((n) => n.text ?? '')
    .join(' ');

describe('markdownToAdf', () => {
  it('produces a valid ADF document envelope', () => {
    const doc = markdownToAdf('# hi');
    expect(doc.version).toBe(1);
    expect(doc.type).toBe('doc');
    expect(doc.content.length).toBeGreaterThan(0);
  });

  it('maps headings with a clamped level attribute', () => {
    const doc = markdownToAdf('# one\n\n### three\n');
    const headings = nodesOfType(doc, 'heading');
    expect(headings.map((h) => h.attrs?.level)).toEqual([1, 3]);
  });

  it('maps ordered and bullet lists to listItems wrapping paragraphs', () => {
    const doc = markdownToAdf('1. first\n2. second\n\n- alpha\n- beta\n');
    expect(nodesOfType(doc, 'orderedList')).toHaveLength(1);
    expect(nodesOfType(doc, 'bulletList')).toHaveLength(1);
    expect(nodesOfType(doc, 'listItem')).toHaveLength(4);
    for (const item of nodesOfType(doc, 'listItem')) {
      expect(item.content?.[0]?.type).toBe('paragraph');
    }
  });

  it('preserves code block language and content', () => {
    const doc = markdownToAdf('```json\n{"a":1}\n```\n');
    const [code] = nodesOfType(doc, 'codeBlock');
    expect(code?.attrs?.language).toBe('json');
    expect(code?.content?.[0]?.text).toBe('{"a":1}');
  });

  it('never puts marks on text inside a code block', () => {
    const doc = markdownToAdf(BUG_REPORT_MARKDOWN);
    for (const code of nodesOfType(doc, 'codeBlock')) {
      for (const child of code.content ?? []) {
        expect(child.marks).toBeUndefined();
      }
    }
  });

  it('maps inline marks and links', () => {
    const doc = markdownToAdf('**bold** and _em_ and `code` and [text](https://example.com/x)');
    const marked = walk(doc).filter((n) => n.marks?.length);
    const byMark = (type: string) => marked.find((n) => n.marks?.some((m) => m.type === type));

    expect(byMark('strong')?.text).toBe('bold');
    expect(byMark('em')?.text).toBe('em');
    expect(byMark('code')?.text).toBe('code');
    const link = byMark('link');
    expect(link?.text).toBe('text');
    expect(link?.marks?.find((m) => m.type === 'link')?.attrs?.href).toBe('https://example.com/x');
  });

  it('keeps nested marks when bold sits inside a link', () => {
    const doc = markdownToAdf('[**bold link**](https://example.com/y)');
    const node = walk(doc).find((n) => n.text === 'bold link');
    expect(node?.marks?.map((m) => m.type).sort()).toEqual(['link', 'strong']);
  });

  it('maps tables to header and body rows', () => {
    const doc = markdownToAdf('| a | b |\n| - | - |\n| 1 | 2 |\n');
    expect(nodesOfType(doc, 'table')).toHaveLength(1);
    expect(nodesOfType(doc, 'tableRow')).toHaveLength(2);
    expect(nodesOfType(doc, 'tableHeader')).toHaveLength(2);
    expect(nodesOfType(doc, 'tableCell')).toHaveLength(2);
  });

  it('degrades raw HTML to text instead of dropping it', () => {
    const doc = markdownToAdf('<div class="callout">important note</div>\n');
    expect(allText(doc)).toContain('important note');
  });

  it('renders task list markers inline', () => {
    const doc = markdownToAdf('- [x] done\n- [ ] pending\n');
    const text = allText(doc);
    expect(text).toContain('[x]');
    expect(text).toContain('[ ]');
    expect(text).toContain('done');
  });

  it('never emits an empty text node', () => {
    const doc = markdownToAdf(BUG_REPORT_MARKDOWN);
    for (const node of walk(doc)) {
      if (node.type === 'text') expect(node.text).toBeTruthy();
    }
  });

  it('returns a valid document for empty and whitespace input', () => {
    for (const input of ['', '   \n\n  ']) {
      const doc = markdownToAdf(input);
      expect(doc.type).toBe('doc');
      expect(doc.content.length).toBeGreaterThan(0);
    }
  });

  it('does not throw on unusual input', () => {
    const inputs = ['|||', '```\nunclosed', '# '.repeat(500), '> > > deep', '[bad](', '- '.repeat(200)];
    for (const input of inputs) {
      expect(() => markdownToAdf(input)).not.toThrow();
    }
  });
});

describe('markdownToAdf on a generated bug report', () => {
  const doc = markdownToAdf(BUG_REPORT_MARKDOWN);

  it('carries every section heading through', () => {
    const headings = nodesOfType(doc, 'heading')
      .map((h) => (h.content ?? []).map((c) => c.text ?? '').join(''))
      .filter(Boolean);
    expect(headings).toEqual([
      'Release date does not default from requested delivery date',
      'Environment',
      'Preconditions',
      'Steps to Reproduce',
      'Actual Result',
      'Expected Result',
      'Evidence',
      'Suggested Root Cause',
      'Assumptions',
    ]);
  });

  it('preserves the structural constructs the spec calls out', () => {
    expect(nodesOfType(doc, 'heading').length).toBeGreaterThan(0);
    expect(nodesOfType(doc, 'orderedList')).toHaveLength(1);
    expect(nodesOfType(doc, 'bulletList').length).toBeGreaterThan(0);
    expect(nodesOfType(doc, 'codeBlock')).toHaveLength(2);
    expect(nodesOfType(doc, 'table')).toHaveLength(1);
    expect(nodesOfType(doc, 'blockquote')).toHaveLength(1);
    expect(nodesOfType(doc, 'rule')).toHaveLength(1);
  });

  it('does not lose distinctive report content', () => {
    const text = allText(doc);
    for (const fragment of [
      'staging',
      'Order Manager',
      'Requested delivery date',
      'Cannot read properties of undefined',
      'order-form.js:214',
      'requestedDeliveryDate',
    ]) {
      expect(text).toContain(fragment);
    }
  });

  it('keeps the failing-request link with its href', () => {
    const link = walk(doc).find((n) => n.text === 'the failing request');
    expect(link?.marks?.find((m) => m.type === 'link')?.attrs?.href).toBe(
      'https://staging.example.com/api/orders',
    );
  });

  it('autolinks the bare URL in the environment table', () => {
    const link = walk(doc).find((n) => n.text === 'https://staging.example.com/orders/new');
    expect(link?.marks?.find((m) => m.type === 'link')?.attrs?.href).toBe(
      'https://staging.example.com/orders/new',
    );
  });
});
