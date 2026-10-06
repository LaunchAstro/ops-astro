// SPDX-License-Identifier: AGPL-3.0-only
//
// C33 cases held until their dependency lands (U36, #483; BUILD-AHEAD-B3
// rule 2). Each is written in full when it is on the branch: AW-02's
// bootstrap-file reference on older runs. The definition reference on a run
// is in `c52a-run-start.test.ts`; the rates in `c33-limits.test.ts`; the run
// ceiling, the intake bound and their fairness in `c33-intake.test.ts`.

import { describe, it } from 'vitest';

describe('C33 held on AW-02', () => {
  it.todo(
    'C33 definition reference, older runs: a run pinned to a bootstrap file keeps that reference after the cutover (AW-02)',
  );
});
