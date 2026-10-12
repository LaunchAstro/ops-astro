// SPDX-License-Identifier: AGPL-3.0-only
//
// The read door lowercases only the operands a read names in `identifiers`
// (`reads/canonical-ids.ts`), so an id operand a read takes but does not name
// keeps the caller's spelling and misses its row. `READ_OPERANDS` gives every
// operand a kind, and the API scan's parity test holds that table to the live
// parsers: an operand the parser reads as a uuid is an `id` there. This file
// holds the other half, both ways: every `id` operand, in every body form, is
// declared, and every declared identifier is an `id` operand.
//
// This suite moves the database counter by zero, so it is a unit suite.

import { expect, it } from 'vitest';
import {
  READ_OPERANDS,
  type ReadBody,
  type ReadOperands,
} from '../../packages/core-wire/src/read-operands.ts';
import { READ_CATALOGUE, type ReadName } from '../../packages/core-commands/src/reads/catalogue.ts';

const rows = Object.entries(READ_CATALOGUE) as [ReadName, (typeof READ_CATALOGUE)[ReadName]][];

function formsOf(body: ReadBody): readonly ReadOperands[] {
  return 'oneOf' in body ? (body.oneOf as readonly ReadOperands[]) : [body as ReadOperands];
}

/** The operands of kind `id` across every form of a read's body. */
function idOperands(body: ReadBody): readonly string[] {
  const ids = new Set<string>();
  for (const form of formsOf(body)) {
    for (const [name, operand] of Object.entries(form)) {
      if (typeof operand === 'string' && /^id(?:\?|\|null|\?\|null)?$/u.test(operand)) {
        ids.add(name);
      }
    }
  }
  return [...ids].toSorted();
}

it.each(rows)('%s declares exactly the id operands it takes', (name, row) => {
  const body = READ_OPERANDS[name];
  expect(body, `${name} has no READ_OPERANDS entry`).toBeDefined();
  expect([...row.identifiers].toSorted()).toStrictEqual(idOperands(body as ReadBody));
});

it('the uuid sweep has an id operand to turn in every read that declares one', () => {
  const declaring = rows.filter(([, row]) => row.identifiers.length > 0).map(([name]) => name);
  expect(declaring.length).toBeGreaterThan(0);
  for (const name of declaring) expect(idOperands(READ_OPERANDS[name] as ReadBody)).not.toEqual([]);
});
