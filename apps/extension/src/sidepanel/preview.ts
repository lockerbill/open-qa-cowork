/**
 * Render a markdown artifact (test cases, bug report) as a styled HTML document
 * and open it in a new browser tab. Mirrors the blob-URL pattern in exports.ts.
 */
import DOMPurify from 'dompurify';
import { marked } from 'marked';

/** Escape text for safe interpolation into HTML (used for the document title). */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** GitHub-like light theme, reusing the side panel palette from styles.css. */
const PREVIEW_STYLES = `
  :root { color-scheme: light; }
  body {
    margin: 0;
    background: #ffffff;
    color: #1f2328;
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  }
  .markdown-body {
    max-width: 860px;
    margin: 0 auto;
    padding: 32px 24px 64px;
  }
  .markdown-body h1, .markdown-body h2 {
    border-bottom: 1px solid #d0d7de;
    padding-bottom: 0.3em;
    margin-top: 1.4em;
  }
  .markdown-body h1:first-child, .markdown-body h2:first-child { margin-top: 0; }
  .markdown-body code {
    background: #f6f8fa;
    border-radius: 6px;
    padding: 0.2em 0.4em;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 85%;
  }
  .markdown-body pre {
    background: #f6f8fa;
    border: 1px solid #d0d7de;
    border-radius: 6px;
    padding: 12px;
    overflow: auto;
  }
  .markdown-body pre code { background: none; padding: 0; }
  .markdown-body table {
    border-collapse: collapse;
    width: 100%;
    margin: 12px 0;
  }
  .markdown-body th, .markdown-body td {
    border: 1px solid #d0d7de;
    padding: 6px 12px;
    text-align: left;
  }
  .markdown-body th { background: #f6f8fa; }
  .markdown-body blockquote {
    margin: 0;
    padding: 0 1em;
    color: #57606a;
    border-left: 0.25em solid #d0d7de;
  }
  .markdown-body a { color: #0969da; }
`;

/**
 * Render markdown to a sanitized HTML fragment for inline display (e.g. chat
 * bubbles). Unlike buildPreviewHtml this returns just the body HTML, not a full
 * document. Sanitized with DOMPurify so it is safe for dangerouslySetInnerHTML.
 */
export function renderMarkdownInline(md: string): string {
  const rendered = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(rendered);
}

/** Convert markdown to a complete, sanitized, styled HTML document. Pure. */
export function buildPreviewHtml(title: string, md: string): string {
  const rendered = marked.parse(md, { async: false }) as string;
  const body = DOMPurify.sanitize(rendered);
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${safeTitle}</title>
<style>${PREVIEW_STYLES}</style>
</head>
<body>
<article class="markdown-body">${body}</article>
</body>
</html>`;
}

/** Render markdown and open it in a new browser tab. */
export function previewMarkdown(title: string, md: string): void {
  const html = buildPreviewHtml(title, md);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  window.open(url, '_blank', 'noopener');
  // Revoke later so the new tab has time to load the blob.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
