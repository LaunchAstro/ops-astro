// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-7 (#640): research runs on research tickets. Tests first, held: every
// named test of the ticket is here as a todo because what a run is built on
// is not on this branch yet. The file is listed as deliberately unnamed in
// the database manifest; at the rebase each todo becomes its test, red
// before the build.
// - `run started (research)` under `run:write` is no longer held: MP-6-2's
//   key and pickup ceiling came with the SL12 stack, and it is
//   `wf-7-run.test.ts` (the refusal by grant and by delegation).
// - Reserve before a priced call, the ceiling, the broker's catalogued
//   operations and model.call: SL11 U100 AW-01; the top-up shape AW-05.
// - Model egress for the map's client is no longer held: C60 came with the
//   SL11 stack, and it is `wf-7-egress.test.ts`.
// - The waiting-run inbox item: SL04 U99 (`inbox_items`, the raise).
// - The ceiling approval's recent sign-in: C59's step-up (S0-5's sweep).
// - The run's lease and checks (SL12 U31, MP-6-1) came with the SL12 stack;
//   the lines that ride on the run are still to build on it.
// - The skill pinned by digest: the digest is settled (the `skills` CLI's
//   folder hash, `skill-digest.ts`; the research skill matches its pin), but
//   the line is the run pinning it, so it waits on the run (U37, U100).

import { describe, it } from 'vitest';

describe('WF-7 held (to build on the run; LEANS-ON the research ceiling, SL04 U99, C59)', () => {
  it.todo('WF-7 isolation');
  it.todo('WF-7 canary');
  it.todo('WF-7 hostile provider');
  it.todo('WF-7 recent sign-in');
  it.todo('WF-7 refusal billing:decide');
  it.todo('WF-7 refusal task:write');
  it.todo('WF-7 reserve before a priced call');
  it.todo('WF-7 no ceiling stops and asks');
  it.todo('WF-7 holds no credential');
  it.todo('WF-7 twice failed');
  it.todo('WF-7 skill pinned by digest');
  it.todo('WF-7 waiting item under the lease');
  it.todo('WF-7 CLI parity');
  it.todo('WF-7 audit readback');
  it.todo(
    'WF-7 owner check: Run on a research ticket with a small approved ceiling claims it, posts a cited answer and closes it; with no ceiling it stops and asks',
  );
});
