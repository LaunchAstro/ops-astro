// SPDX-License-Identifier: AGPL-3.0-only
// What the review-evidence check reads: the pull request body as GitHub
// renders it, and whether an issue is open.
//
// Issue 88, 29 September. Eight CQ-13 review passes each found a crafted body
// that hand-written Markdown rules read differently from GitHub: setext
// underlines, nested quotes, `<pre>`, inline `<code>`, backtick spans paired
// across blocks. The body is now parsed once by markdown-it, a CommonMark
// parser with GitHub's tables and strikethrough, pinned in package.json and
// recorded in docs/supply-chain-pins.md. What GitHub shows and what the check
// reads are then one tree, not two guesses at it.

import MarkdownIt from 'markdown-it';

// `html: true` makes a tag an HTML node rather than text, so it can be refused.
const md = new MarkdownIt('commonmark', { html: true }).enable(['table', 'strikethrough']);

// A line that names a review field after any run of marks, in the raw source
// or in the text GitHub shows, where an escape or an entity can spell a field
// the raw line does not. Marks are dropped one at a time, so a long run of
// them reads in linear time.
const MARK = /^(?:\[[xX]\]|\d{1,9}[.)]|[^\p{L}\p{N}])/u;
const NAME = /^(code[ -]review|security[ -]review|reviewer|model|head[ -]sha|verdict)[*_`~ \t]*:/iu;
const namesField = (text) => {
  let rest = text;
  for (let m = MARK.exec(rest); m !== null; m = MARK.exec(rest)) rest = rest.slice(m[0].length);
  return NAME.exec(rest)?.[1];
};
// A counted field: the raw line at the margin, bold or underscore allowed.
const PLAIN_FIELD =
  /^[*_]{0,3}(?:code[ -]review|security[ -]review|reviewer|model|head sha|verdict)[*_]{0,3}[ \t]*:/iu;
const FIELD =
  /^(code[ -]review|security[ -]review|reviewer|model|head sha|verdict)[ \t]*:[ \t]*(.*)$/iu;
const fieldKey = (name) =>
  name
    .toLowerCase()
    .replace(/[ -]review$/u, '')
    .replace('-', ' ');

// An inline node's children, one entry per line GitHub shows. Only text and
// emphasis keep a line plain; a code span, a link, an image, strikethrough or
// HTML in it does not. #92, Sol's criterion 1: markdown-it lists a run's
// children flat, each open/close pair marked by `nesting` +1 and -1, so any
// pair of any kind open across a line break wraps both lines and neither is
// plain. Emphasis counts only opened and closed on the line itself.
const PLAIN_NODE = new Set(['text', 'strong_open', 'strong_close', 'em_open', 'em_close']);
const shownLines = (inline) => {
  const out = [{ text: '', plain: true }];
  let open = 0;
  for (const child of inline.children ?? []) {
    const at = out.at(-1);
    if (child.type === 'softbreak' || child.type === 'hardbreak') {
      if (open !== 0) at.plain = false;
      out.push({ text: '', plain: open === 0 });
      continue;
    }
    open += child.nesting;
    if (!PLAIN_NODE.has(child.type)) at.plain = false;
    if (['text', 'code_inline', 'image'].includes(child.type)) at.text += child.content;
    else if (child.type === 'html_inline') at.text += ' ';
  }
  return out;
};

// A comment hides its text and is allowed; any other HTML fails. Read as the
// browser closes it (`<!-->`, `<!--->`, `--!>`), and to the end when unclosed,
// so no tag survives inside what looked like one comment.
const COMMENT = new RegExp(String.raw`<!--(?:-?>|[\s\S]*?(?:--!?>|$))`, 'gu');
const notComment = (html) => html.replaceAll(COMMENT, '').trim();
// Indented code is refused a tag too: a sample goes in a fence or a span.
const TAG = /<(?:\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>]|$)|![A-Za-z]|!\[CDATA\[|\?)/mu;

/**
 * The body as GitHub renders it.
 *  - stated: every counted `Code review:` and `Security review:` field;
 *  - record: every counted reviewer, model, head sha and verdict value;
 *  - buried: every other line that is written or shown as a review field;
 *  - html: every HTML node that is not only a comment, its first 40 characters;
 *  - prose: the text shown, code included, comments left out.
 * A field counts only as a plain line of a top-level paragraph, at the
 * margin, where the paragraph's shown lines are its source lines one for one.
 */
export const readBody = (body) => {
  const source = body.replaceAll(/\r\n?/gu, '\n');
  const lines = source.split('\n');
  const tokens = md.parse(source, {});
  const read = { stated: [], record: { reviewer: [], model: [], 'head sha': [], verdict: [] } };
  const counted = new Set();
  const buried = [];
  const html = [];
  const prose = [];
  for (const [i, token] of tokens.entries()) {
    if (token.type === 'fence' || token.type === 'code_block') prose.push(token.content);
    const tag = token.type === 'code_block' ? TAG.exec(token.content) : null;
    if (tag !== null) html.push(tag[0]);
    if (token.type === 'html_block' && notComment(token.content) !== '') html.push(token.content);
    if (token.type !== 'inline') continue;
    for (const child of token.children ?? []) {
      if (child.type === 'html_inline' && notComment(child.content) !== '')
        html.push(child.content);
    }
    const shown = shownLines(token);
    prose.push(shown.map((l) => l.text).join('\n'));
    const map = token.map ?? [0, 0];
    const top =
      tokens[i - 1]?.type === 'paragraph_open' &&
      tokens[i - 1]?.level === 0 &&
      shown.length === map[1] - map[0];
    for (const [k, line] of shown.entries()) {
      const named = namesField(line.text);
      if (named === undefined) continue;
      const raw = top ? (lines[map[0] + k] ?? '') : '';
      const field = FIELD.exec(line.text);
      if (!top || !line.plain || field === null || !PLAIN_FIELD.test(raw)) {
        buried.push(
          `${token.map === null ? line.text.trim() : `line ${map[0] + k + 1}`}: ${fieldKey(named)}`,
        );
        continue;
      }
      counted.add(map[0] + k);
      const name = fieldKey(field[1] ?? '');
      const value = (field[2] ?? '').trim();
      if (name === 'code' || name === 'security')
        read.stated.push({ name, value, line: raw.trim() });
      else read.record[name].push(value);
    }
  }
  for (const [i, line] of lines.entries()) {
    const named = namesField(line);
    if (named !== undefined && !counted.has(i)) buried.push(`line ${i + 1}: ${fieldKey(named)}`);
  }
  const snips = html.map((h) => h.trim().slice(0, 40));
  return { ...read, buried: [...new Set(buried)], html: snips, prose: prose.join('\n') };
};

/**
 * The follow-up outcomes, of `values`, whose issue is not open in this
 * repository now. OPEN_ISSUES, a list of numbers, stands in for GitHub in the
 * cases; with neither, no issue is shown open. This proves the issue exists
 * and is open, not what it holds.
 */
export const unfiled = async (values) => {
  const filed = values.flatMap((v) => {
    // Normalised as the outcome grammar reads it: trimmed, one full stop off.
    const text = v.trim().replace(/\.$/u, '').trim();
    const n = /follow-up\s+#(\d{1,7})$/iu.exec(text)?.[1];
    return n === undefined ? [] : [[v, n]];
  });
  const open = await Promise.all(filed.map(([, n]) => isOpen(n)));
  return new Set(filed.filter((_, i) => !open[i]).map(([v]) => v));
};

const isOpen = async (n) => {
  const listed = process.env['OPEN_ISSUES'];
  if (listed !== undefined) return listed.split(/[\s,]+/u).includes(n);
  const repo = process.env['GITHUB_REPOSITORY'] ?? '';
  const token = process.env['GH_TOKEN'] ?? '';
  if (repo === '' || token === '') return false;
  const api = process.env['GITHUB_API_URL'] ?? 'https://api.github.com';
  try {
    const res = await fetch(`${api}/repos/${repo}/issues/${n}`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const issue = await res.json();
    return issue.state === 'open' && issue.pull_request === undefined;
  } catch {
    return false;
  }
};
