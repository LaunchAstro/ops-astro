// SPDX-License-Identifier: AGPL-3.0-only
//
// The client's read union against the server's own surface.
//
// `OperationsClient.read` derives its route from the name through `pathOf`, so
// a name in the union that the server does not declare is not a type error and
// not a build failure: it is a 404 in front of a person, at the moment they
// open the screen. The union was three names behind the surface for exactly
// that reason and two screens carried casts to get past it. This case is what
// replaces the casts.

import { describe, expect, it } from 'vitest';

import { READ_NAMES } from '../../apps/web/src/operations/client.ts';
import { COMMAND_SURFACE } from '../../packages/core-records/src/commands/surface.ts';

const declaredReads = new Set(
  COMMAND_SURFACE.filter((command) => command.kind === 'read').map((command) => command.name),
);

describe("the client's read names", () => {
  it('are each declared on the surface as a read', () => {
    const undeclared = READ_NAMES.filter((name) => !declaredReads.has(name));
    expect(undeclared).toEqual([]);
  });

  it('name no write', () => {
    const writes = new Set(
      COMMAND_SURFACE.filter((command) => command.kind !== 'read').map((command) => command.name),
    );
    expect(READ_NAMES.filter((name) => writes.has(name))).toEqual([]);
  });

  it('are distinct, so the union cannot hide a duplicate', () => {
    expect(new Set(READ_NAMES).size).toBe(READ_NAMES.length);
  });

  it('leave only the reads no screen reaches, named so the gap stays visible', () => {
    // Not a rule about what the client must reach — a statement of what it does
    // not, so adding a screen for one of these is a deliberate edit here rather
    // than a silent change in coverage.
    const unreached = [...declaredReads].filter(
      (name) => !READ_NAMES.some((reached) => reached === name),
    );
    expect(unreached.toSorted()).toEqual(['preset.plan', 'task.queue']);
  });
});
