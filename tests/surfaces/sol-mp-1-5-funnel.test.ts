// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const root = fileURLToPath(new URL('../..', import.meta.url));

it('Sol proof, criterion MP-1-5 5: the true-scale funnel remains visible at phone width', () => {
  const css = readFileSync(`${root}packages/ui/src/styles/2-primitives.css`, 'utf8');
  const hidesShapeAtPhoneWidth =
    /@media\s*\(width\s*<=\s*640px\)[\s\S]*?\.funnel__shape\s*\{[^}]*display:\s*none/u.test(
      css,
    );
  expect(hidesShapeAtPhoneWidth).toBe(false);
});
