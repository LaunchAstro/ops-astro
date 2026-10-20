// SPDX-License-Identifier: AGPL-3.0-only
//
// The Connections sheets carry a few short class names (a standing approval's
// `.ps` and `.pslist`, the night round's `.nr`, a connector's
// `.panel__actions`, the shared note line `.approval__meta`). Declared bare,
// any of them would restyle a later page that picks the same name, so each
// rule that styles one starts from the page or the region that owns it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const styles = fileURLToPath(new URL('../../packages/ui/src/styles/', import.meta.url));
const SHEETS = ['7-connections', '7-connections-region', '7-connections-costing'];

/** Every selector a sheet's rules start with, inside an at-rule or not. */
const selectorsOf = (css: string): string[] =>
  [...css.replaceAll(/\/\*[\s\S]*?\*\//gu, '').matchAll(/([^{};]+)\{/gu)]
    .map((match) => (match[1] ?? '').trim())
    .filter((prelude) => !prelude.startsWith('@'))
    .flatMap((prelude) => prelude.split(','))
    .map((selector) => selector.trim());

/** A selector whose leftmost part is one of the short names, or a part of a standing approval. */
const BARE = /^\.(?:ps|pslist|nr|panel__actions|approval__meta)(?![\w-])|^\.ps(?:--|__)/u;

it('the connections sheets declare no short class name bare', () => {
  const bare = SHEETS.flatMap((sheet) =>
    selectorsOf(readFileSync(`${styles}${sheet}.css`, 'utf8'))
      .filter((selector) => BARE.test(selector))
      .map((selector) => `${sheet}: ${selector}`),
  );
  expect(bare).toEqual([]);
});
