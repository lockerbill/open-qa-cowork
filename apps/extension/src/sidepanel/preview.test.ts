import { describe, it, expect } from 'vitest';
import { buildPreviewHtml } from './preview.js';

describe('buildPreviewHtml', () => {
  it('renders markdown headings, lists, and tables as HTML', () => {
    const md = ['# Login flow', '', '- step one', '- step two', '', '| a | b |', '| - | - |', '| 1 | 2 |'].join('\n');
    const html = buildPreviewHtml('Test cases', md);
    expect(html).toContain('<h1>Login flow</h1>');
    expect(html).toContain('<li>step one</li>');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>a</th>');
  });

  it('escapes the title in the document head', () => {
    const html = buildPreviewHtml('Test & <cases>', '# hi');
    expect(html).toContain('<title>Test &amp; &lt;cases&gt;</title>');
    expect(html).not.toContain('<title>Test & <cases></title>');
  });

  it('sanitizes dangerous HTML out of the rendered markdown', () => {
    const html = buildPreviewHtml('t', '<script>alert(1)</script>\n\nok');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('alert(1)');
  });

  it('strips inline event handlers and javascript: URLs', () => {
    const html = buildPreviewHtml('t', '<a href="javascript:alert(1)" onclick="alert(2)">x</a>');
    expect(html).not.toContain('onclick');
    expect(html.toLowerCase()).not.toContain('javascript:');
  });

  it('produces a complete HTML document', () => {
    const html = buildPreviewHtml('Bug report', '# Bug');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
    expect(html).toContain('class="markdown-body"');
  });
});
