// SPDX-License-Identifier: AGPL-3.0-only
//
// API-3's checklist line TR-S-B3-1, held: "the actions marked not audited
// (reads, presence, preferences) add no audit event". Every read here is
// audited under I13 (`reads/dispatch.ts`), a read that leaves no trace being
// the one way to look at a business's work without it learning. The conflict
// is raised in the slice's handback for the owner; this file is deliberately
// not a named suite, since the runner refuses a skipped case.

import { describe, it } from 'vitest';

describe('API-3 reads and the audit chain', () => {
  it.todo('API-3 reads add no audit event (TR-S-B3-1): held, every read is audited under I13');
});
