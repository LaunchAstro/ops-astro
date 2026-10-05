// SPDX-License-Identifier: AGPL-3.0-only
//
// The page Astro's compiler prints, read from its compiled module with a
// JavaScript parser: where the edited word sits, which `$$render` template
// holds it, and what each expression in that template prints. Read by
// `body-copy-tokens.ts`.

import { parse, parseExpressionAt, type Node, type TemplateLiteral } from 'acorn';

export interface WordSwap {
  readonly word: string;
  readonly replacement: string;
}

/** What an expression in a template prints, as far as the grammar knows. */
export type Interpolation = 'markup' | 'attributes' | 'text' | 'unknown';

export interface WordInTemplate {
  readonly template: TemplateLiteral;
  /** The index of the static text holding the word. */
  readonly quasi: number;
  /** Where the word starts in that text, cooked. */
  readonly offset: number;
}

/** Runtime calls that print whole markup in data state. */
const PRINTS_MARKUP: ReadonlySet<string> = new Set([
  '$$renderComponent',
  '$$renderSlot',
  '$$renderHead',
  '$$maybeRenderHead',
  '$$renderScript',
]);
const PRINTS_ATTRIBUTES: ReadonlySet<string> = new Set(['$$addAttribute', '$$spreadAttributes']);

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'type' in value;
}

function children(node: Node): Node[] {
  return Object.entries(node)
    .flatMap(([key, value]: [string, unknown]) =>
      key === 'loc' ? [] : Array.isArray(value) ? (value as unknown[]) : [value],
    )
    .filter((value) => isNode(value));
}

/** The plain name a call calls. */
function calls(node: Node): string | undefined {
  if (node.type !== 'CallExpression' || !('callee' in node) || !isNode(node.callee)) return;
  const { callee } = node;
  return callee.type === 'Identifier' && 'name' in callee && typeof callee.name === 'string'
    ? callee.name
    : undefined;
}

function isRenderTemplate(node: Node): node is Node & { quasi: TemplateLiteral } {
  if (node.type !== 'TaggedTemplateExpression' || !('tag' in node) || !isNode(node.tag)) {
    return false;
  }
  return node.tag.type === 'Identifier' && 'name' in node.tag && node.tag.name === '$$render';
}

/** Every `$$render` template in the module, and whether the module prints raw markup (set:html). */
function templatesOf(program: Node): { templates: TemplateLiteral[]; raw: boolean } {
  const templates: TemplateLiteral[] = [];
  let raw = false;
  const visit = (node: Node) => {
    if (calls(node) === '$$unescapeHTML') raw = true;
    if (isRenderTemplate(node)) templates.push(node.quasi);
    for (const child of children(node)) visit(child);
  };
  visit(program);
  return { templates, raw };
}

/** The one offset at which swapping the word in `before` gives `after`. */
function swappedAt(before: string, after: string, swap: WordSwap): number | undefined {
  const { word, replacement } = swap;
  if (after.length !== before.length - word.length + replacement.length) return;
  let prefix = 0;
  while (prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const found: number[] = [];
  for (let at = Math.max(0, before.length - word.length - suffix); at <= prefix; at += 1) {
    if (before.startsWith(word, at) && after.startsWith(replacement, at)) found.push(at);
  }
  return found.length === 1 ? found[0] : undefined;
}

/** A template literal's raw text as its cooked string, when it cooks. */
function cook(raw: string): string | undefined {
  let literal;
  try {
    literal = parseExpressionAt(`\`${raw}\``, 0, { ecmaVersion: 'latest' });
  } catch {
    return;
  }
  if (literal.type !== 'TemplateLiteral' || literal.end !== raw.length + 2) return;
  return literal.quasis[0]?.value.cooked ?? undefined;
}

export function interpolation(expression: Node): Interpolation {
  const name = calls(expression);
  // Any other expression's value goes through the runtime's escaping as text.
  if (name === undefined || !name.startsWith('$$')) return 'text';
  if (PRINTS_MARKUP.has(name)) return 'markup';
  return PRINTS_ATTRIBUTES.has(name) ? 'attributes' : 'unknown';
}

/**
 * The templates of the module before the edit and the static text holding
 * the swapped word, when the two modules differ by that word alone, at one
 * place in a `$$render` template's text, and the module prints no raw markup.
 */
export function wordInTemplate(
  before: string,
  after: string,
  swap: WordSwap,
): { templates: readonly TemplateLiteral[]; word: WordInTemplate } | undefined {
  const at = swappedAt(before, after, swap);
  if (at === undefined) return;
  let program: Node;
  try {
    program = parse(before, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return;
  }
  const { templates, raw } = templatesOf(program);
  if (raw) return;
  const end = at + swap.word.length;
  const holds = ({ start, end: stop }: { start: number; end: number }) =>
    start <= at && end <= stop;
  const template = templates.find(({ quasis }) => quasis.some((quasi) => holds(quasi)));
  const index = template?.quasis.findIndex((quasi) => holds(quasi)) ?? -1;
  const quasi = template?.quasis[index];
  if (template === undefined || quasi === undefined) return;
  const lead = cook(before.slice(quasi.start, at));
  if (lead === undefined || !(quasi.value.cooked ?? '').startsWith(swap.word, lead.length)) return;
  return { templates, word: { template, quasi: index, offset: lead.length } };
}
