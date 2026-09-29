// SPDX-License-Identifier: AGPL-3.0-only
// `pnpm tokens:diff`: the token file against the expected light and dark sets.
//
// It reads the two blocks of `packages/ui/src/styles/1-tokens.css` that carry
// values, `:root` and `[data-theme='dark']`, and resolves every `var()` the way
// the browser does when both blocks sit on the same element: dark declarations
// win where they exist and every reference is substituted after that, so an
// alias declared only in `:root` still follows a primitive the dark block
// flips. Each expected token is then compared, as text with its whitespace
// collapsed, to what that resolution gives. A token that is missing or differs
// is named with both values and the run exits 1.
//
//   node scripts/token-diff.mjs [--css <file>] [--expected <file>]
//   node scripts/token-diff.mjs --print [--css <file>]   the resolved sets as JSON

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_CSS = `${root}packages/ui/src/styles/1-tokens.css`;
const DEFAULT_EXPECTED = `${root}tests/surfaces/fixtures/mp-1-1-tokens.json`;

/** The declarations of the first block whose selector is exactly `selector`. */
function block(css, selector) {
  const bare = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  const start = bare.search(new RegExp(`(^|\\})\\s*${selector}\\s*\\{`, 'u'));
  if (start < 0) return new Map();
  const open = bare.indexOf('{', start + 1);
  const body = bare.slice(open + 1, bare.indexOf('}', open));
  const declared = new Map();
  for (const line of body.split(';')) {
    const at = line.indexOf(':');
    const name = line.slice(0, at).trim();
    if (!name.startsWith('--')) continue;
    declared.set(
      name,
      line
        .slice(at + 1)
        .replace(/\s+/gu, ' ')
        .trim(),
    );
  }
  return declared;
}

/** Every declared token with its references substituted, in one theme. */
function resolve(declared) {
  const out = {};
  const value = (name, depth) => {
    const raw = declared.get(name);
    if (raw === undefined || depth > 20) return undefined;
    return raw.replace(/var\((--[\w-]+)\)/gu, (whole, ref) => value(ref, depth + 1) ?? whole);
  };
  for (const name of declared.keys()) out[name] = value(name, 0);
  return out;
}

/** The resolved light and dark sets of a token file's text. */
export function resolveTokens(css) {
  const light = block(css, ':root');
  const dark = new Map([...light, ...block(css, "\\[data-theme='dark'\\]")]);
  return { light: resolve(light), dark: resolve(dark) };
}

/** One line per expected token that is missing or differs, in either theme. */
export function diffTokens(css, expected) {
  const got = resolveTokens(css);
  const problems = [];
  for (const theme of ['light', 'dark']) {
    for (const [name, want] of Object.entries(expected[theme] ?? {})) {
      const have = got[theme][name];
      if (have !== want) problems.push(`${theme} ${name}: want ${want}, got ${have ?? 'nothing'}`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (flag, fallback) => {
    const at = args.indexOf(flag);
    return at < 0 ? fallback : args[at + 1];
  };
  const css = readFileSync(option('--css', DEFAULT_CSS), 'utf8');
  if (args.includes('--print')) {
    process.stdout.write(`${JSON.stringify(resolveTokens(css), null, 2)}\n`);
  } else {
    const expected = JSON.parse(readFileSync(option('--expected', DEFAULT_EXPECTED), 'utf8'));
    const problems = diffTokens(css, expected);
    for (const line of problems) console.error(`token drift: ${line}`);
    if (problems.length > 0) process.exit(1);
    console.log(`tokens: ${Object.keys(expected.light).length} tokens match in light and dark`);
  }
}
