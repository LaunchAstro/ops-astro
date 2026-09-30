// SPDX-License-Identifier: AGPL-3.0-only
//
// C33 cases held until the agent engine lands (U36, #483; BUILD-AHEAD-B3
// rule 2); the occurrence rates are in `c33-limits.test.ts`. Each is written
// in full when its dependency is on the branch:
// AW-02's definition reference slot on a run (`run_definition_pins`, kind
// `definition_version`), and AW-01's run creation under the worker lease, its
// durable ceilings and its fair-share limiter, which C33's limits reuse rather
// than build a second limiter.

import { describe, it } from 'vitest';

describe('C33 held on AW-01 and AW-02', () => {
  it.todo(
    'C33 definition reference: a run started from an activation names its definition version; older runs keep their bootstrap-file reference (AW-02)',
  );
  it.todo(
    'C33 run ceiling waits: the 5th activation run in flight starts, the 6th waits shown as waiting and starts when a run finishes, across a restart (AW-01)',
  );
  it.todo(
    'C33 event intake bounded: the 1,000th event is queued, the 1,001st refused at intake and recorded, and intake resumes once the queue drains (AW-01)',
  );
  it.todo(
    'C33 run ceiling and intake fair across businesses: one business at its run ceiling and intake bound never delays another business (AW-01); the hourly rates are in c33-limits.test.ts',
  );
});
