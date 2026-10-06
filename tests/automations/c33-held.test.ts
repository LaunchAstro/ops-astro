// SPDX-License-Identifier: AGPL-3.0-only
//
// C33 cases held until their dependency lands (U36, #483; BUILD-AHEAD-B3
// rule 2). Each is written in full when it is on the branch: AW-02's
// definition reference slot on a run (`run_definition_pins`, kind
// `definition_version`), and C52-A's standing approval, the one outcome that
// lets an occurrence through to AW-01's durable limit (`hasRoom`), which C33's
// limits reuse rather than build a second limiter.

import { describe, it } from 'vitest';

describe('C33 held on C52-A and AW-02', () => {
  it.todo(
    'C33 definition reference: a run started from an activation names its definition version; older runs keep their bootstrap-file reference (AW-02)',
  );
  it.todo(
    'C33 occurrence rate refused: the 60th occurrence in an hour per activation starts and the 61st is refused and recorded, 600 and 601 per business, the next window fires, and the count survives a scheduler restart (C52-A)',
  );
  it.todo(
    'C33 run ceiling waits: the 5th activation run in flight starts, the 6th waits shown as waiting and starts when a run finishes, across a restart (C52-A)',
  );
  it.todo(
    'C33 event intake bounded: the 1,000th event is queued, the 1,001st refused at intake and recorded, and intake resumes once the queue drains (C52-A)',
  );
  it.todo(
    'C33 limits fair across businesses: one business at its ceiling and intake bound never delays another business (C52-A)',
  );
});
