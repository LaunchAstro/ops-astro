// SPDX-License-Identifier: AGPL-3.0-only
//
// The source scan behind `mp-6-2-no-memory.test.ts`'s only-one-writer proof,
// moved whole from that file to keep it under the line limit.

import { readdirSync, readFileSync } from 'node:fs';

/** Every product source file under `roots`, as `path` and text. */
export const sources = (
  roots: readonly string[],
): { readonly path: string; readonly text: string }[] =>
  roots.flatMap((root) =>
    readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.(tsx?|sql)$/u.test(file) && !file.includes('node_modules'))
      .map((file) => ({ path: `${root}/${file}`, text: readFileSync(`${root}/${file}`, 'utf8') })),
  );

/** The files whose SQL writes `run_states`: an insert, update or delete naming it. */
export const writersOf = (
  files: readonly { readonly path: string; readonly text: string }[],
): string[] =>
  files
    .filter(({ text }) =>
      /\b(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?"?run_states"?\b/iu.test(text),
    )
    .map(({ path }) => path)
    .toSorted();
