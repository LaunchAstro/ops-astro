// SPDX-License-Identifier: AGPL-3.0-only
//
// The exported operation surface, read from the code rather than from a list.
//
// T1-R7 asks for an enumeration "generated from the exported surface", and
// section 7.4's P1 records that nobody had shown it could be built. The trap is
// obvious once named: if every surface derives its set from `COMMAND_SURFACE`,
// a test comparing them compares a derivation with its own source and cannot
// fail. T1f hit that shape with `NEEDS_NO_EXPECTED_REVISION` and answered it by
// writing the second list by hand. That answer will not do here, because a
// hand-maintained parity list is exactly what 7.4 forbids as a discharge.
//
// So the enumeration comes from a fourth place none of the three surfaces
// reads: the dispatch in `commands/handlers.ts`, where a name becomes work. A
// command with no case there does nothing; a case there with no declaration
// cannot be reached. Every surface is then compared against it rather than
// against a sibling.
//
// **This is source parsing and should be read as such.** It is honest because
// it fails when the code really diverges — a case removed from the dispatch
// fails parity even though every surface still lists the command. It is weak
// because a switch is syntax, so an unusual rewrite of that file breaks the
// reader rather than the claim. The guard is the floor below: a reader that has
// stopped working fails loudly instead of passing vacuously.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CommandName } from '../commands/surface.ts';

const DISPATCH_SOURCE = fileURLToPath(new URL('../commands/handlers.ts', import.meta.url));

/** `case 'task.create':` and nothing looser. */
const CASE_LABEL = /^\s*case\s+'(?<name>[a-z][a-z_]*\.[a-z][a-z_]*)'\s*:/gmu;

/**
 * Every command name the dispatch actually handles.
 *
 * Thrown rather than refused: a build whose operation surface cannot be read
 * has no claim to make about parity, and a returned empty set would be a claim.
 */
export function exportedOperationSurface(): ReadonlySet<CommandName> {
  const source = readFileSync(DISPATCH_SOURCE, 'utf8');
  const names = new Set<CommandName>();
  for (const match of source.matchAll(CASE_LABEL)) {
    const name = match.groups?.['name'];
    if (name !== undefined) names.add(name as CommandName);
  }
  if (names.size < MINIMUM_CREDIBLE) {
    throw new Error(
      `exportedOperationSurface: read ${String(names.size)} operations from the dispatch, ` +
        `which is below the ${String(MINIMUM_CREDIBLE)} the contract's nine and the model's ` +
        'owning operations require. The reader has stopped working, or the dispatch was ' +
        'rewritten into a shape it does not understand. Fix the reader; do not lower this.',
    );
  }
  return names;
}

/**
 * The floor that stops a broken reader passing quietly.
 *
 * Nine from the minimum contract plus the eight owning operations the task
 * type's field definitions name. The three trash-family commands are above it
 * deliberately: this is a floor, not a count, and a count here would be a
 * second hand-maintained list of the kind this file exists to avoid.
 */
const MINIMUM_CREDIBLE = 17;
