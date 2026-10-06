// SPDX-License-Identifier: AGPL-3.0-only
//
// parse5's tree of markup the reading has admitted (capture/page.ts), built with the reading's own
// moves: a node is found from the end of its parent, so an insert near the end costs what the
// reading's bound already charged for it, never the parent's whole length.

import {
  defaultTreeAdapter,
  parse,
  type DefaultTreeAdapterTypes as Tree,
  type TreeAdapter,
} from 'parse5';

const at = (parent: Tree.ParentNode, node: Tree.ChildNode): number =>
  parent.childNodes.lastIndexOf(node);

const adapter: TreeAdapter<Tree.DefaultTreeAdapterMap> = {
  ...defaultTreeAdapter,
  insertBefore(parent, node, before) {
    parent.childNodes.splice(at(parent, before), 0, node);
    node.parentNode = parent;
  },
  detachNode(node) {
    if (node.parentNode) node.parentNode.childNodes.splice(at(node.parentNode, node), 1);
    node.parentNode = null;
  },
  insertTextBefore(parent, text, before) {
    const previous = parent.childNodes[at(parent, before) - 1];
    if (previous && defaultTreeAdapter.isTextNode(previous)) previous.value += text;
    else adapter.insertBefore(parent, defaultTreeAdapter.createTextNode(text), before);
  },
};

/** The tree of markup `readDocument` admitted, in the time its bounds hold. Only for such markup. */
export const admittedTree = (html: string): Tree.Document => parse(html, { treeAdapter: adapter });
