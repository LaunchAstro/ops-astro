// SPDX-License-Identifier: AGPL-3.0-only
//
// C33's case held until AW-02's cutover lands (U36, #483; BUILD-AHEAD-B3
// rule 2): runs pinned to a bootstrap file. The occurrence rates are in
// `c33-limits.test.ts`, the run ceiling and event intake in
// `c33-intake.test.ts`, and a run's definition version reference in
// `c52a-run-start.test.ts`.

import { describe, it } from 'vitest';

describe('C33 held on AW-02', () => {
  it.todo(
    'C33 definition reference, older runs: a run pinned to a bootstrap file keeps that reference after the cutover (AW-02)',
  );
});
