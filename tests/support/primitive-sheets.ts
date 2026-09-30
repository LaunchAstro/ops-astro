// SPDX-License-Identifier: AGPL-3.0-only
//
// The kit's primitive stylesheets as the bundle loads them: every
// `./styles/2-*.css` the package entry imports, in import order, joined into
// one text. A test that reads the kit's rules reads all of them, so a rule
// moved from one of these sheets to another is still read. It refuses when it
// finds none, or when a `2-*.css` sheet on disk is not imported.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ui = join(import.meta.dirname, '../../packages/ui/src/');

const PRIMITIVE_SHEETS: readonly string[] = [
  ...readFileSync(`${ui}index.ts`, 'utf8').matchAll(/^import '\.\/(styles\/2-[\w-]+\.css)';$/gmu),
].map((match) => `${ui}${match[1] ?? ''}`);

const onDisk = readdirSync(`${ui}styles`).filter((name) => /^2-[\w-]+\.css$/u.test(name));
if (PRIMITIVE_SHEETS.length === 0 || onDisk.length !== PRIMITIVE_SHEETS.length) {
  throw new Error(
    `primitive sheets: the package imports ${String(PRIMITIVE_SHEETS.length)}, the styles folder holds ${onDisk.join(', ')}`,
  );
}

export const primitiveSheets = (): string =>
  PRIMITIVE_SHEETS.map((path) => readFileSync(path, 'utf8')).join('\n');
