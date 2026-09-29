// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm type:census`: every text style in the product on the declared scale (MP-1-4).
//
// The scale is the 23 `--type-<name>` styles the token file declares, each a
// `font` shorthand with `--type-<name>-tracking` and `--type-<name>-case`
// beside it (TOKENS.md DS-TOK-107 to 129). A rule sets text in one way only:
//
//   font: var(--type-<name>);
//   letter-spacing: var(--type-<name>-tracking);
//   text-transform: var(--type-<name>-case);
//
// all three together, so nothing leaks in from a parent; or `inherit`, for form
// controls. Any other size, weight, family, line height, tracking or case is
// refused, unless its rule carries a marker naming the ruling that keeps it:
//
//   /* type-exception DR-6: the run hero's mono 20 number */
//
// Component files may not style text inline or through SVG font attributes.
// The census counts the rules drawing each style: 20 or fewer beyond the three
// figure sizes (`--type-num-*`), and every exception listed with its ruling.
//
//   node scripts/type-census.mjs [--json] [--tokens <file>] [--css <file>]... [--tsx <file>]...

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const STYLES = `${root}packages/ui/src/styles`;
const DEFAULT_TOKENS = `${STYLES}/1-tokens.css`;
const DEFAULT_CSS = [STYLES, `${root}apps/web/src/styles`];
const DEFAULT_TSX = [`${root}packages/ui/src`, `${root}apps/web/src`];

const TEXT = new Set([
  'font',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-transform',
]);
/** At-rules whose blocks hold rules that apply; every other block (font faces, keyframes) is skipped. */
const CONDITIONAL = new Set(['media', 'supports', 'container', 'layer', 'scope', 'starting-style']);
const NUMBER = /^--type-num-/u;
const RULING = /^type-exception\s+(R\d+|DR-\d+|DS-[A-Z]+-\d+)\s*:\s*\S/u;
const LIMIT = 20;

/** One declaration's property and value, the value without `!important`; undefined for no colon. */
function declOf(text) {
  const at = text.indexOf(':');
  if (at < 0) return;
  return {
    prop: text.slice(0, at).trim().toLowerCase(),
    value: text
      .slice(at + 1)
      .replace(/!\s*important\s*$/iu, '')
      .replaceAll(/\s+/gu, ' ')
      .trim(),
  };
}

/** The frame a block opens: a style rule, a conditional at-rule that holds rules, or a block skipped whole. */
function blockOf(prelude, parent) {
  const context = parent.context ?? '';
  if (parent.kind === 'skip') return { kind: 'skip' };
  if (!prelude.startsWith('@'))
    return { kind: 'rule', selector: prelude, context, decls: [], comments: [] };
  const name = prelude.slice(1).split(/[\s(]/u)[0].toLowerCase();
  return CONDITIONAL.has(name)
    ? { kind: 'at', context: `${context}${prelude} ` }
    : { kind: 'skip' };
}

/**
 * Every style rule of a sheet: its selector (with the conditions it sits in),
 * its declarations and the comments inside its own body. Strings, comments and
 * parentheses are read whole, so a brace or semicolon inside one splits nothing.
 */
export function parseSheet(css) {
  const rules = [];
  const stack = [{ kind: 'root', context: '' }];
  let buf = '';
  let parens = 0;
  const top = () => stack.at(-1);
  const flush = () => {
    const text = buf.trim();
    buf = '';
    const frame = top();
    if (text === '' || frame.kind !== 'rule') return;
    const decl = declOf(text);
    if (decl !== undefined) frame.decls.push(decl);
  };
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      const stop = end < 0 ? css.length : end;
      if (top().kind === 'rule') top().comments.push(css.slice(i + 2, stop).trim());
      i = stop + 1;
    } else if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < css.length && css[j] !== ch) j += css[j] === '\\' ? 2 : 1;
      buf += css.slice(i, j + 1);
      i = j;
    } else if (ch === '(') {
      parens += 1;
      buf += ch;
    } else if (ch === ')') {
      parens = Math.max(0, parens - 1);
      buf += ch;
    } else if (ch === ';' && parens === 0) {
      flush();
    } else if (ch === '{') {
      const prelude = buf.replaceAll(/\s+/gu, ' ').trim();
      buf = '';
      stack.push(blockOf(prelude, top()));
    } else if (ch === '}') {
      flush();
      const frame = stack.length > 1 ? stack.pop() : top();
      if (frame.kind === 'rule') rules.push(frame);
    } else buf += ch;
  }
  return rules;
}

/** The styles a token file declares: `--type-<name>` in its `:root` blocks, with their companions. */
export function declaredStyles(tokensCss) {
  const names = new Set();
  for (const rule of parseSheet(tokensCss)) {
    if (rule.selector !== ':root' || rule.context !== '') continue;
    for (const { prop } of rule.decls) if (prop.startsWith('--type-')) names.add(prop);
  }
  const styles = [...names].filter((name) => !/-(tracking|case)$/u.test(name));
  const missing = styles.flatMap((name) =>
    ['tracking', 'case']
      .filter((part) => !names.has(`${name}-${part}`))
      .map((part) => `${name}: no ${name}-${part} declared beside it`),
  );
  return { styles, missing };
}

/**
 * A rule's font: `inherit` with its companions, or one declared type style
 * with its tracking and case set to that style's own. Marks what it accounts
 * for, records what is wrong, and returns the style it drew, if any.
 */
function fontOf(value, declared, accounted, violations, where) {
  const font = value('font');
  if (font === 'inherit') {
    accounted.add('font');
    for (const prop of ['letter-spacing', 'text-transform'])
      if (value(prop) === 'inherit' || value(prop) === undefined) accounted.add(prop);
    return;
  }
  if (font === undefined) return;
  const name = /^var\(\s*(--type-[a-z0-9-]+)\s*\)$/u.exec(font)?.[1];
  if (name === undefined || !declared.includes(name)) {
    violations.push(`${where}: font is not a declared type style (font: ${font})`);
    return;
  }
  accounted.add('font');
  for (const [prop, part] of [
    ['letter-spacing', 'tracking'],
    ['text-transform', 'case'],
  ]) {
    if (value(prop) === `var(${name}-${part})`) accounted.add(prop);
    else if (value(prop) === undefined)
      violations.push(`${where}: ${name} without ${prop}: var(${name}-${part})`);
  }
  return name;
}

/** One sheet's rules against the declared styles: what each rule draws, its exception and its strays. */
function censusSheet(file, css, declared) {
  const used = [];
  const exceptions = [];
  const violations = [];
  for (const rule of parseSheet(css)) {
    const where = `${file}: ${rule.context}${rule.selector}`;
    const text = rule.decls.filter(({ prop }) => TEXT.has(prop));
    const markers = rule.comments.filter((comment) => /^type-exception\b/u.test(comment));
    const ruling = markers.map((marker) => RULING.exec(marker)?.[1]).find(Boolean);
    for (const marker of markers)
      if (!RULING.test(marker)) violations.push(`${where}: exception marker names no ruling`);
    const value = (prop) => text.findLast((decl) => decl.prop === prop)?.value;
    const accounted = new Set();
    const name = fontOf(value, declared, accounted, violations, where);
    if (name !== undefined) used.push(name);
    const strays = text.filter(({ prop }) => !accounted.has(prop));
    if (ruling !== undefined && strays.length > 0) {
      exceptions.push({
        file,
        selector: rule.selector,
        ruling,
        overrides: strays.map(({ prop, value: v }) => `${prop}: ${v}`),
      });
    } else {
      if (ruling !== undefined)
        violations.push(`${where}: exception marker on a rule with no override`);
      for (const { prop, value: v } of strays)
        violations.push(`${where}: ${prop}: ${v} is not a declared type style`);
    }
  }
  return { used, exceptions, violations };
}

/** Text styled from a component file: inline style keys and SVG font attributes. */
const INLINE =
  /(?<![\w-])(fontSize|fontWeight|fontFamily|lineHeight|letterSpacing|textTransform|font-size|font-weight|font-family|line-height|letter-spacing|text-transform)\s*[:=]|['"](font|font-size|font-weight|font-family|line-height|letter-spacing|text-transform)['"]\s*:|(?<=[{,]\s*)font\s*:/gu;

function censusComponent(file, source) {
  const code = source.replaceAll(/\/\*[\s\S]*?\*\//gu, '').replaceAll(/(^|[^:'"])\/\/.*$/gmu, '$1');
  return [...code.matchAll(INLINE)].map(
    (match) => `${file}: text styled inline (${match[0].replace(/\s*[:=]$/u, '')})`,
  );
}

/** The census over the given sheets and component files. */
export function census({ tokens, css, tsx }) {
  const { styles: declared, missing } = declaredStyles(readFileSync(tokens, 'utf8'));
  const used = {};
  const exceptions = [];
  const violations = [...missing];
  for (const path of css) {
    const file = relative(root, path);
    const sheet = censusSheet(file, readFileSync(path, 'utf8'), declared);
    for (const name of sheet.used) used[name] = (used[name] ?? 0) + 1;
    exceptions.push(...sheet.exceptions);
    violations.push(...sheet.violations);
  }
  for (const path of tsx)
    violations.push(...censusComponent(relative(root, path), readFileSync(path, 'utf8')));
  const aboveTwenty = declared.filter((name) => NUMBER.test(name));
  for (const [what, names] of [
    ['declared', declared],
    ['drawn', Object.keys(used)],
  ]) {
    const beyond = names.filter((name) => !NUMBER.test(name));
    if (beyond.length > LIMIT)
      violations.push(
        `${String(beyond.length)} styles ${what} beyond the figure sizes (limit ${String(LIMIT)})`,
      );
  }
  const unused = declared.filter((name) => used[name] === undefined);
  return { declared, used, unused, aboveTwenty, exceptions, violations };
}

/** Every file under `dir` (recursively) whose name ends in one of `endings`. */
const files = (dir, endings) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && endings.some((ending) => entry.name.endsWith(ending)))
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted();

if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  const all = (flag) => args.flatMap((arg, at) => (arg === flag ? [args[at + 1]] : []));
  const css = all('--css');
  const tsx = all('--tsx');
  const result = census({
    tokens: all('--tokens')[0] ?? DEFAULT_TOKENS,
    css: css.length > 0 ? css : DEFAULT_CSS.flatMap((dir) => files(dir, ['.css'])),
    tsx: css.length > 0 ? tsx : DEFAULT_TSX.flatMap((dir) => files(dir, ['.ts', '.tsx'])),
  });
  for (const line of result.violations) console.error(`type census: ${line}`);
  if (args.includes('--json')) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    const drawn = Object.keys(result.used);
    console.log(
      `type census: ${String(drawn.length)} of ${String(result.declared.length)} styles drawn, ` +
        `${String(drawn.filter((name) => !NUMBER.test(name)).length)} beyond the figure sizes; ` +
        `${String(result.exceptions.length)} listed exceptions`,
    );
    for (const e of result.exceptions)
      console.log(`  exception ${e.ruling}: ${e.file} ${e.selector} (${e.overrides.join('; ')})`);
  }
  if (result.violations.length > 0) process.exit(1);
}
