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

/**
 * Runtime calls that print whole markup in data state; a component's is
 * checked apart. A slot or script prints what the page's own source steers.
 */
const PRINTS_MARKUP: ReadonlySet<string> = new Set(['$$renderHead', '$$maybeRenderHead']);
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

/** Names a binding gives: declarations, parameters and catch clauses, patterns whole. */
function bindings(node: Node): Node[] {
  const take = (key: string) =>
    key in node ? [(node as unknown as Record<string, unknown>)[key]] : [];
  const held = [
    ...(node.type === 'VariableDeclarator' ? take('id') : []),
    ...(node.type.includes('Function') ? [...take('id'), ...take('params')] : []),
    ...(node.type === 'CatchClause' || node.type === 'ClassDeclaration'
      ? [...take('param'), ...take('id')]
      : []),
  ];
  return held.flat().filter((value) => isNode(value));
}

function names(node: Node): string[] {
  const own = node.type === 'Identifier' && 'name' in node ? [String(node.name)] : [];
  return [...own, ...children(node).flatMap((child) => names(child))];
}

interface ModuleReading {
  readonly templates: TemplateLiteral[];
  /** Names the module imports, which nothing in it rebinds. */
  readonly imported: ReadonlySet<string>;
  /** Whether it can print raw markup of its own: any other use of `$$unescapeHTML` or `$$render`. */
  readonly raw: boolean;
}

/** Every `$$render` template in the module, what it imports, and whether it prints raw markup. */
function readModule(program: Node): ModuleReading {
  const templates: TemplateLiteral[] = [];
  const imported = new Set<string>();
  const bound = new Set<string>();
  let raw = false;
  const visit = (node: Node) => {
    if (node.type === 'ImportDeclaration') {
      for (const specifier of 'specifiers' in node ? (node.specifiers as Node[]) : []) {
        if ('local' in specifier && isNode(specifier.local)) {
          for (const name of names(specifier.local)) imported.add(name);
        }
      }
      return;
    }
    const named = node.type === 'Identifier' && 'name' in node ? node.name : undefined;
    if (named === '$$unescapeHTML' || named === '$$render') raw = true;
    for (const binding of bindings(node)) for (const name of names(binding)) bound.add(name);
    if (isRenderTemplate(node)) {
      templates.push(node.quasi);
      visit(node.quasi);
      return;
    }
    for (const child of children(node)) visit(child);
  };
  visit(program);
  for (const name of bound) imported.delete(name);
  return { templates, imported, raw };
}

/** A string or number written in the page, or an untagged template of them: escaped as text. */
function isLiteralText(node: Node): boolean {
  if (node.type === 'Literal' && 'value' in node) {
    return typeof node.value === 'string' || typeof node.value === 'number';
  }
  if (node.type === 'TemplateLiteral' && 'expressions' in node) {
    return (node.expressions as Node[]).every((expression) => isLiteralText(expression));
  }
  return false;
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

/**
 * What an expression prints: a literal is text, a component is markup only
 * when it is imported and never rebound, attribute calls print attributes.
 * Anything else, a value the page computes included, is unknown: the
 * runtime prints a value that is not a string as raw markup.
 */
function interpolation(expression: Node, imported: ReadonlySet<string>): Interpolation {
  if (isLiteralText(expression)) return 'text';
  const name = calls(expression);
  if (name === '$$renderComponent') {
    const component = 'arguments' in expression ? (expression.arguments as Node[])[2] : undefined;
    const known =
      component?.type === 'Identifier' &&
      'name' in component &&
      imported.has(String(component.name));
    return known ? 'markup' : 'unknown';
  }
  if (name !== undefined && PRINTS_MARKUP.has(name)) return 'markup';
  return name !== undefined && PRINTS_ATTRIBUTES.has(name) ? 'attributes' : 'unknown';
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
):
  | {
      templates: readonly TemplateLiteral[];
      word: WordInTemplate;
      kindOf: (expression: Node) => Interpolation;
    }
  | undefined {
  const at = swappedAt(before, after, swap);
  if (at === undefined) return;
  let program: Node;
  try {
    program = parse(before, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return;
  }
  const { templates, imported, raw } = readModule(program);
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
  const kindOf = (expression: Node) => interpolation(expression, imported);
  return { templates, word: { template, quasi: index, offset: lead.length }, kindOf };
}
