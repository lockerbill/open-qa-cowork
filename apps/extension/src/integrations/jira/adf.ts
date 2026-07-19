/**
 * markdown -> Atlassian Document Format (ADF).
 *
 * Jira Cloud REST v3 takes issue descriptions as ADF JSON rather than markdown,
 * so generated bug-report markdown must be converted before it can be posted.
 *
 * Two invariants from the jira-integration spec ("Description rendering"):
 * constructs with no ADF equivalent degrade to plain-text paragraphs instead of
 * being dropped, and conversion never throws — a malformed report should still
 * reach Jira as readable text.
 *
 * This lives in the extension rather than `packages/shared` because it needs
 * `marked`, and that package deliberately carries no runtime dependencies
 * (design.md Decision 3).
 */
import { lexer, type Token, type Tokens } from 'marked';

export type AdfMarkType = 'strong' | 'em' | 'code' | 'strike' | 'link';

export interface AdfMark {
  type: AdfMarkType;
  attrs?: { href: string };
}

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: AdfMark[];
}

export interface AdfDoc {
  version: 1;
  type: 'doc';
  content: AdfNode[];
}

/** ADF rejects empty text nodes, so callers must be able to contribute nothing. */
function textNode(text: string, marks: AdfMark[]): AdfNode[] {
  if (!text) return [];
  return marks.length > 0 ? [{ type: 'text', text, marks }] : [{ type: 'text', text }];
}

function paragraph(content: AdfNode[]): AdfNode {
  return content.length > 0 ? { type: 'paragraph', content } : { type: 'paragraph' };
}

/** Last-resort rendering for any token we have no mapping for. */
function plainParagraph(raw: string): AdfNode[] {
  const text = raw.trim();
  return text ? [paragraph(textNode(text, []))] : [];
}

function withMark(marks: AdfMark[], mark: AdfMark): AdfMark[] {
  return marks.some((m) => m.type === mark.type) ? marks : [...marks, mark];
}

/**
 * Convert inline tokens, threading accumulated marks down through nesting so
 * that e.g. bold-inside-a-link keeps both.
 */
function inlineNodes(tokens: Token[] | undefined, marks: AdfMark[]): AdfNode[] {
  if (!tokens) return [];
  const out: AdfNode[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'text':
      case 'escape': {
        const t = token as Tokens.Text;
        // A `text` token may itself carry inline children (marked nests this way
        // inside list items and table cells).
        if (t.tokens && t.tokens.length > 0) out.push(...inlineNodes(t.tokens, marks));
        else out.push(...textNode(t.text, marks));
        break;
      }
      case 'strong':
        out.push(...inlineNodes((token as Tokens.Strong).tokens, withMark(marks, { type: 'strong' })));
        break;
      case 'em':
        out.push(...inlineNodes((token as Tokens.Em).tokens, withMark(marks, { type: 'em' })));
        break;
      case 'del':
        out.push(...inlineNodes((token as Tokens.Del).tokens, withMark(marks, { type: 'strike' })));
        break;
      case 'codespan':
        out.push(...textNode((token as Tokens.Codespan).text, withMark(marks, { type: 'code' })));
        break;
      case 'link': {
        const t = token as Tokens.Link;
        const linked = withMark(marks, { type: 'link', attrs: { href: t.href } });
        const children = inlineNodes(t.tokens, linked);
        out.push(...(children.length > 0 ? children : textNode(t.text || t.href, linked)));
        break;
      }
      case 'image': {
        // ADF media nodes require a prior upload to Jira's media store, so an
        // inline image degrades to a link rather than being dropped.
        const t = token as Tokens.Image;
        out.push(...textNode(t.text || t.href, withMark(marks, { type: 'link', attrs: { href: t.href } })));
        break;
      }
      case 'br':
        out.push({ type: 'hardBreak' });
        break;
      default: {
        const t = token as Tokens.Generic;
        out.push(...textNode(typeof t.text === 'string' ? t.text : String(t.raw ?? ''), marks));
        break;
      }
    }
  }

  return out;
}

function listItemNode(item: Tokens.ListItem): AdfNode {
  const content = blockNodes(item.tokens);
  if (content.length === 0) content.push({ type: 'paragraph' });

  // ADF has taskList/taskItem, but those need stable localIds we have no source
  // for; render the marker inline so checklists survive intact.
  if (item.task) {
    const marker = item.checked ? '[x] ' : '[ ] ';
    const first = content[0];
    if (first?.type === 'paragraph') first.content = [...textNode(marker, []), ...(first.content ?? [])];
  }

  return { type: 'listItem', content };
}

function cellNodes(cells: Tokens.TableCell[], type: 'tableHeader' | 'tableCell'): AdfNode[] {
  return cells.map((cell) => ({ type, attrs: {}, content: [paragraph(inlineNodes(cell.tokens, []))] }));
}

function tableNode(token: Tokens.Table): AdfNode {
  const rows: AdfNode[] = [];
  if (token.header.length > 0) {
    rows.push({ type: 'tableRow', content: cellNodes(token.header, 'tableHeader') });
  }
  for (const row of token.rows) {
    rows.push({ type: 'tableRow', content: cellNodes(row, 'tableCell') });
  }
  return { type: 'table', attrs: { isNumberColumnEnabled: false, layout: 'default' }, content: rows };
}

function blockNodes(tokens: Token[]): AdfNode[] {
  const out: AdfNode[] = [];

  for (const token of tokens) {
    switch (token.type) {
      case 'space':
      case 'def':
        break;
      case 'heading': {
        const t = token as Tokens.Heading;
        const level = Math.min(Math.max(Math.trunc(t.depth) || 1, 1), 6);
        out.push({ type: 'heading', attrs: { level }, content: inlineNodes(t.tokens, []) });
        break;
      }
      case 'paragraph':
        out.push(paragraph(inlineNodes((token as Tokens.Paragraph).tokens, [])));
        break;
      case 'text': {
        // Block position: loose list items and similar surface their content here.
        const t = token as Tokens.Text;
        out.push(paragraph(t.tokens ? inlineNodes(t.tokens, []) : textNode(t.text, [])));
        break;
      }
      case 'code': {
        const t = token as Tokens.Code;
        const node: AdfNode = { type: 'codeBlock', attrs: t.lang ? { language: t.lang } : {} };
        // Text inside a codeBlock must be mark-free, so it is built directly.
        if (t.text) node.content = [{ type: 'text', text: t.text }];
        out.push(node);
        break;
      }
      case 'blockquote': {
        const inner = blockNodes((token as Tokens.Blockquote).tokens);
        out.push({ type: 'blockquote', content: inner.length > 0 ? inner : [{ type: 'paragraph' }] });
        break;
      }
      case 'list': {
        const t = token as Tokens.List;
        const items = t.items.map(listItemNode);
        if (items.length === 0) break;
        out.push(
          t.ordered
            ? { type: 'orderedList', attrs: { order: typeof t.start === 'number' ? t.start : 1 }, content: items }
            : { type: 'bulletList', content: items },
        );
        break;
      }
      case 'hr':
        out.push({ type: 'rule' });
        break;
      case 'table':
        out.push(tableNode(token as Tokens.Table));
        break;
      default:
        // Raw HTML and anything else marked hands back: keep the text, lose the form.
        out.push(...plainParagraph(String((token as Tokens.Generic).raw ?? '')));
        break;
    }
  }

  return out;
}

/** Split arbitrary text into paragraphs on blank lines. Used only as a fallback. */
function plainTextDoc(md: string): AdfNode[] {
  const blocks = md
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => paragraph(textNode(s, [])));
  return blocks.length > 0 ? blocks : [{ type: 'paragraph' }];
}

/**
 * Convert report markdown to an ADF document. Never throws: if the lexer fails
 * on malformed input, the whole document degrades to plain-text paragraphs.
 */
export function markdownToAdf(md: string): AdfDoc {
  const source = md ?? '';
  try {
    const content = blockNodes(lexer(source));
    return { version: 1, type: 'doc', content: content.length > 0 ? content : [{ type: 'paragraph' }] };
  } catch {
    return { version: 1, type: 'doc', content: plainTextDoc(source) };
  }
}
