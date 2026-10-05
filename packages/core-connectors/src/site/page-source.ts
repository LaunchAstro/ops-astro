// SPDX-License-Identifier: AGPL-3.0-only
//
// Whether a page's own source runs no code, read from the tree Astro's
// compiler parses. A page's code runs when the site builds and renders it
// and can change what the runtime prints (its escaping, head and slots), and
// the bundler rewrites a page's own script and style before they are
// printed, so no grammar over the printed page holds while any of it is
// there. The source must take one closed shape, and anything else is refused:
//
// - the frontmatter only imports other Astro files, one default name each,
//   from a relative path that is not the page itself;
// - the body holds text, comments, a doctype, fragments, allow-listed
//   elements and components the frontmatter imports;
// - every attribute is a quoted literal or empty, its name plain lower-case,
//   never `slot`;
// - no expression, script, style, slot or custom element anywhere.

import { parse, type Node } from 'acorn';
import { posix } from 'node:path';
import type { RootNode } from '@astrojs/compiler/types';

type PageNode = RootNode | RootNode['children'][number];
type AttributeNode = Extract<PageNode, { attributes: unknown }>['attributes'][number];

/** Elements Astro prints as written: no script, style, slot, select, svg, math or raw-text form. */
const ELEMENTS: ReadonlySet<string> = new Set(
  (
    'a abbr address article aside b bdi bdo blockquote body br cite code data dd del dfn ' +
    'div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 head header hr html i ins ' +
    'kbd label li main mark meta nav ol p pre q s samp section small span strong sub sup ' +
    'time title u ul var wbr'
  ).split(' '),
);
const ATTRIBUTE_NAME = /^[a-z][a-z0-9-]*$/u;
const PATH_NAME = /^[A-Za-z0-9_-]+$/u;
const IMPORT_KEYS = 'attributes end source specifiers start type';

/** A relative path of plain names to an Astro file, resolved against the page; never the page. */
function otherAstroFile(specifier: unknown, page: string): boolean {
  if (typeof specifier !== 'string') return false;
  const segments = specifier.split('/');
  const file = segments.at(-1) ?? '';
  const plain =
    (segments[0] === '.' || segments[0] === '..') &&
    segments.slice(1, -1).every((name) => name === '.' || name === '..' || PATH_NAME.test(name)) &&
    file.endsWith('.astro') &&
    PATH_NAME.test(file.slice(0, -'.astro'.length));
  if (!plain || segments.length < 2) return false;
  const resolved = posix.normalize(posix.join(posix.dirname(page), specifier));
  return resolved.toLowerCase() !== posix.normalize(page).toLowerCase();
}

/** The names the frontmatter imports, or `undefined` when it holds anything else. */
function importedNames(frontmatter: string, page: string): Set<string> | undefined {
  let program: Node;
  try {
    program = parse(frontmatter, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    return;
  }
  const names = new Set<string>();
  for (const statement of 'body' in program ? (program.body as Node[]) : []) {
    if (statement.type !== 'ImportDeclaration') return;
    if (Object.keys(statement).toSorted().join(' ') !== IMPORT_KEYS) return;
    const { specifiers, source, attributes } = statement as unknown as {
      specifiers: { type: string; local: { name: string } }[];
      source: { value: unknown };
      attributes: unknown[];
    };
    const [only] = specifiers;
    if (specifiers.length !== 1 || only?.type !== 'ImportDefaultSpecifier') return;
    if (attributes.length > 0 || !otherAstroFile(source.value, page)) return;
    names.add(only.local.name);
  }
  return names;
}

function plainAttributes(attributes: readonly AttributeNode[]): boolean {
  return attributes.every(
    ({ kind, name }) =>
      (kind === 'quoted' || kind === 'empty') && ATTRIBUTE_NAME.test(name) && name !== 'slot',
  );
}

function plainBody(node: PageNode, components: ReadonlySet<string>): boolean {
  const body = (children: readonly PageNode[]) =>
    children.every((child) => plainBody(child, components));
  switch (node.type) {
    case 'text':
    case 'comment':
    case 'doctype':
      return true;
    case 'element':
      return ELEMENTS.has(node.name) && plainAttributes(node.attributes) && body(node.children);
    case 'fragment':
      return (
        (node.name === '' || node.name === 'Fragment') &&
        node.attributes.length === 0 &&
        body(node.children)
      );
    case 'component':
      return components.has(node.name) && plainAttributes(node.attributes) && body(node.children);
    default:
      return false;
  }
}

/** Whether the parsed page at `page` runs no code of its own (see the header). */
export function runsNoCode(root: PageNode, page: string): boolean {
  if (root.type !== 'root') return false;
  const [first, ...rest] = root.children;
  const components =
    first?.type === 'frontmatter' ? importedNames(first.value, page) : new Set<string>();
  if (components === undefined) return false;
  const body = first?.type === 'frontmatter' ? rest : root.children;
  return body.every((child) => plainBody(child, components));
}
