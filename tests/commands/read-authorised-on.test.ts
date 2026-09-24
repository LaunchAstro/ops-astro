// SPDX-License-Identifier: AGPL-3.0-only
//
// A read's `authorisedOn` says what its grant check is asked about, as a
// command's does (`surface.ts`, `CommandDeclaration`). Nothing on the read path
// consumes it: `reads/dispatch.ts` asks at record scope exactly when the
// catalogue row resolves a subject record, and at business scope otherwise. So
// the declaration is held to the catalogue here, or it could say anything
// (THERMO-RECHECK-2 H3: `task.read` was declared `business`).

import { describe, expect, it } from 'vitest';
import { COMMAND_SURFACE } from '../../packages/core-records/src/commands/surface.ts';
import { READ_CATALOGUE } from '../../packages/core-records/src/reads/catalogue.ts';

describe("a read's declared authority scope", () => {
  const reads = COMMAND_SURFACE.filter((row) => row.kind === 'read');

  it('is the scope the read path checks at', () => {
    const declared = Object.fromEntries(reads.map((row) => [row.name, row.authorisedOn]));
    const checked = Object.fromEntries(
      Object.entries(READ_CATALOGUE).map(([name, row]) => [
        name,
        'subject' in row ? 'record' : 'business',
      ]),
    );
    expect(declared).toStrictEqual(checked);
  });

  it('is record scope for task.read alone', () => {
    const record = reads.filter((row) => row.authorisedOn === 'record').map((row) => row.name);
    expect(record).toStrictEqual(['task.read']);
  });
});
