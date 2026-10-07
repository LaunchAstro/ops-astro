// SPDX-License-Identifier: AGPL-3.0-only
//
// A page source as its build serves it and the capture reads it: the frontmatter fence read as a
// closed grammar, then parse5's tree block by block, with no hidden element's text. The live
// check (reconcile.ts) places the approved occurrence on this render.

import { html as markup, type DefaultTreeAdapterTypes as Tree } from 'parse5';
import { readDocument } from '../capture/page.ts';
import { admittedTree } from '../capture/tree.ts';
import { closingFence } from './fence.ts';
// Elements that start a rendered block of their own.
const BLOCK = new Set(
  (
    'address article aside blockquote br dd div dt figcaption footer h1 h2 h3 h4 h5 h6 header ' +
    'hr li main nav p section td th'
  ).split(' '),
);
// Elements whose text the capture never reads (capture/page.ts): these in HTML, and script and
// style anywhere.
const HIDDEN = new Set('script style noscript template iframe noembed noframes'.split(' '));
export const visible = (text: string): string => text.replaceAll(/\s+/gu, ' ').trim();

type Step = { readonly node: Tree.Node; readonly hidden: boolean } | { readonly block: boolean };

/**
 * Markup as the capture reads it, block by block: parse5's tree, so no hidden element's text
 * counts and every character reference decodes as a browser decodes it. Undefined where the
 * capture refuses the markup, or reads the whole page otherwise than these blocks joined.
 */
function rendered(html: string): string[] | undefined {
  const whole = readDocument(html);
  if (typeof whole === 'string') return undefined;
  const blocks = [''];
  const stack: Step[] = [{ node: admittedTree(html), hidden: false }];
  for (let step = stack.pop(); step !== undefined; step = stack.pop()) {
    if ('block' in step) {
      if (step.block) blocks.push('');
      else blocks[blocks.length - 1] += ' ';
      continue;
    }
    const { node, hidden } = step;
    if (node.nodeName === '#text' && !hidden)
      blocks[blocks.length - 1] += (node as Tree.TextNode).value;
    if (!('childNodes' in node)) continue;
    let hides = hidden;
    if ('tagName' in node) {
      const html5 = node.namespaceURI === markup.NS.HTML;
      const name = node.tagName;
      hides ||= HIDDEN.has(name) && (html5 || name === 'script' || name === 'style');
      // An element breaks the text where it opens and closes, a block element into a new block.
      const block = html5 && BLOCK.has(name);
      if (block) blocks.push('');
      else blocks[blocks.length - 1] += ' ';
      stack.push({ block });
    }
    for (const child of node.childNodes.toReversed()) stack.push({ node: child, hidden: hides });
  }
  const page = blocks.map((block) => visible(block));
  return visible(page.join(' ')) === whole.text ? page : undefined;
}

/**
 * The source's page as its build serves it: the frontmatter between two plain `---` lines, the
 * first opening the file (after any byte-order mark or blank lines), never renders. Any other
 * line holding `---` or `+++` (carriage returns alone make the file one such line), a third
 * fence, or one after other text leaves no page.
 */
export function served(source: string): string[] | undefined {
  const lines = source
    .replace(/^\uFEFF/u, '')
    .replaceAll('\r\n', '\n')
    .split('\n');
  const close = closingFence(lines);
  return close === undefined ? undefined : rendered(lines.slice(close + 1).join('\n'));
}
