// SPDX-License-Identifier: AGPL-3.0-only
//
// Finds refusal shapes in TypeScript source, for CQ-5's one-refusal check.
//
// TypeScript 7 ships no JS type-checker API, so this reads declarations
// itself: each `type` and `interface` as union branches of intersection
// operands (and `extends` clauses), with named operands resolved through a
// registry of every declaration scanned. It is a reader for tests, not a
// parser: it is proved by the planted cases in `tests/commands/cq-5.test.ts`.

/** A `refused` or a `code` among an object's own members, shorthand or typed. */
const OWN_MEMBER = {
  refused: /(^|[\s;,{])(readonly\s+)?refused\??\s*[:,;]/u,
  code: /(^|[\s;,{])(readonly\s+)?code\??\s*[:,;]/u,
};

const stripComments = (text: string) => text.replaceAll(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, '');

/** The index just past the bracket that closes the one at `from`, or the end. */
function closing(source: string, from: number): number {
  let depth = 0;
  for (let i = from; i < source.length; i += 1) {
    if ('{([<'.includes(source[i] ?? '')) depth += 1;
    if ('})]>'.includes(source[i] ?? '') && source[i - 1] !== '=') depth -= 1;
    if (depth === 0) return i + 1;
  }
  return source.length;
}

/** `text` cut at `sep` wherever no bracket is open. */
function topLevel(text: string, sep: string): string[] {
  const parts: string[] = [];
  let [depth, last] = [0, 0];
  for (let i = 0; i < text.length; i += 1) {
    if ('{([<'.includes(text[i] ?? '')) depth += 1;
    if ('})]>'.includes(text[i] ?? '') && text[i - 1] !== '=') depth -= 1;
    if (depth === 0 && text[i] === sep) [parts[parts.length], last] = [text.slice(last, i), i + 1];
  }
  return [...parts, text.slice(last)].map((part) => part.trim()).filter(Boolean);
}

/**
 * Every `type` and `interface` declared in `source`: its union branches, each
 * the operands its intersection (or `extends` clause) joins, and its span.
 */
function declaredTypes(source: string) {
  const found: { name: string; start: number; end: number; branches: string[][] }[] = [];
  for (const m of source.matchAll(/\b(type|interface)\s+(\w+)\s*/gu)) {
    let at = m.index + m[0].length;
    if (source[at] === '<') at = closing(source, at);
    if (m[1] === 'type') {
      if (!/^\s*=/u.test(source.slice(at))) continue;
      const rest = source.slice(source.indexOf('=', at) + 1);
      const body = topLevel(rest, ';')[0] ?? '';
      const branches = topLevel(body, '|').map((branch) => topLevel(branch, '&'));
      found.push({ name: m[2] ?? '', start: m.index, end: at + body.length, branches });
    } else {
      const open = source.indexOf('{', at);
      const bases = source.slice(at, open).replace(/^\s*extends\s*/u, '');
      const block = source.slice(open, closing(source, open));
      found.push({
        name: m[2] ?? '',
        start: m.index,
        end: open + block.length,
        branches: [[block, ...topLevel(bases, ',')]],
      });
    }
  }
  return found;
}

type Registry = ReadonlyMap<string, string[][]>;
export const registryOf = (texts: readonly string[]): Registry =>
  new Map(texts.flatMap((t) => declaredTypes(stripComments(t)).map((d) => [d.name, d.branches])));

/** Which of `refused` and `code` an intersection's operands declare, through named types. */
function membersOf(operands: readonly string[], registry: Registry, seen = new Set<string>()) {
  const members = new Set<string>();
  for (const operand of operands) {
    const blocks = operand.startsWith('{') ? [operand] : [];
    const name = /^(?:readonly\s+)?(\w+)/u.exec(operand)?.[1];
    if (name !== undefined && !seen.has(name)) {
      for (const branch of registry.get(name) ?? [])
        for (const member of membersOf(branch, registry, new Set([...seen, name])))
          members.add(member);
      blocks.push(...[...operand.matchAll(/\{[^{}]*\}/gu)].map((b) => b[0]));
    }
    for (const block of blocks) {
      let own = block.slice(1, -1);
      while (/\{[^{}]*\}/u.test(own)) own = own.replaceAll(/\{[^{}]*\}/gu, '');
      for (const key of ['refused', 'code'] as const)
        if (OWN_MEMBER[key].test(`${own};`)) members.add(key);
    }
  }
  return members;
}

/**
 * Every declared shape in `text` with both a `refused` and a `code` member,
 * read through intersections, `extends` and named types (from `registry` too,
 * so a split across files is found), and every object literal outside a
 * declaration with both, so a hand-built refusal is found. A declaration that
 * only names another type is an alias of it, not a second shape. Named by the
 * declaration, or `literal`.
 */
export function refusalShapes(
  file: string,
  text: string,
  elsewhere: Registry = new Map(),
): string[] {
  const source = stripComments(text);
  const declared = declaredTypes(source);
  const registry = new Map([...elsewhere, ...declared.map((d) => [d.name, d.branches] as const)]);
  const found = declared
    .filter((d) =>
      d.branches.some(
        (b) =>
          !(b.length === 1 && /^\w+(<[^{]*>)?$/u.test(b[0] ?? '')) &&
          membersOf(b, registry).size === 2,
      ),
    )
    .map((d) => `${file}:${d.name}`);
  const open: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '{') open.push(i);
    if (source[i] !== '}') continue;
    const start = open.pop() ?? 0;
    if (declared.some((d) => start > d.start && start < d.end)) continue;
    if (membersOf([source.slice(start, i + 1)], registry).size === 2) found.push(`${file}:literal`);
  }
  return found.toSorted();
}
