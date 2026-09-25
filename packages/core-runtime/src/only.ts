// SPDX-License-Identifier: AGPL-3.0-only
//
// "The row I just locked, inserted or updated exists." The runtime used to say
// that with a cast, `rows[0] as Row`, and a cast that was ever wrong became an
// `undefined` read a few lines later as a `TypeError` naming a property. `only`
// says it once and fails loudly under its own name, naming what was expected.

/** A runtime invariant that did not hold. Never a refusal: it aborts the transaction. */
export class RuntimeInvariantError extends Error {
  override readonly name = 'RuntimeInvariantError';
}

/** The first row of a statement that must have returned one. */
export function only<Row>(rows: readonly Row[], what: string): Row {
  const row = rows[0];
  if (row === undefined) {
    throw new RuntimeInvariantError(`${what}: the statement returned no row`);
  }
  return row;
}
