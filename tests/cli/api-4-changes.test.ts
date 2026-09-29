// SPDX-License-Identifier: AGPL-3.0-only
//
// API-4's *changes since* (#632): held. It returns only what changed after a
// point the agent holds, from the live-sync change record (C4), which lands
// with SL10 U26 and does not exist on this branch (LEANS-ON SL10 U26). Each
// line below is its named test, written as a todo until then; the file is
// listed as deliberately unnamed in the database manifest, which refuses a
// skipped test in a named suite. At the rebase: build the read on C4's
// record, turn each todo into its case, name this file and add the read to
// the read-audit and quota suites and the pins listing every read.

import { describe, it } from 'vitest';

describe('API-4 changes since (held: LEANS-ON SL10 U26, the C4 live change record)', () => {
  it.todo('API-4 changes since returns only records changed after the point, in one call');
  it.todo('API-4 changes since returns nothing the caller may not read');
  it.todo('API-4 changes since: a read after a write never shows the old state');
  it.todo('API-4 changes since is one query on the change record');
  it.todo('API-4 isolation: changes since');
  it.todo('API-4 quota: changes since is charged like every call');
  it.todo('API-3 changes since writes exactly its one audit event');
});
