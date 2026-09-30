// SPDX-License-Identifier: AGPL-3.0-only
//
// WF-6's held lines (#639). Each waits on another slice's unmerged unit and
// stays a todo, named after its line, until the rebase brings that unit in.
// The file is listed as deliberately unnamed in the database manifest.
// - The sidebar conversation: the agent drawer (MP-7-11) and its exchange
//   (AW-03, SL12 U32). Its model call's seam (AW-01) and the client's model
//   egress (C60) came with the SL11 stack; the egress line is the sidebar's
//   call on a client map, so it waits on the exchange too (the ticket run's
//   refusal is wf-7-egress).
// The pinned skill through the tracker operations is no longer held: the
// digest is the `skills` CLI's folder hash, and it is `wf-6-skill.test.ts`.
// - An agent charting inside its delegation: SL09 U18 (API-2); until then
//   `map.chart` is `agent: 'never'` and an agent is refused (wf-6.test.ts).
// - The look: the width-and-theme harness (MP-1-7) came with batch 1; what
//   it would draw is the sidebar conversation above (SL12 U32), not built.

import { describe, it } from 'vitest';

describe('WF-6 held (LEANS-ON SL12 U32, SL09 U18)', () => {
  it.todo(
    'WF-6 owner check: in the sidebar the agent asks for the destination, lists its open questions, pre-answers the decided ones with a source, and files a map whose only grilling tickets are real choices',
  );
  it.todo(
    'WF-6 on a client map with model egress off, no model call is made and the agent says so',
  );
  it.todo('WF-6 an agent charts a map inside its delegation, task:write narrowed from the person');
  it.todo('WF-6 visual match at desktop, tablet and phone widths, light and dark (MP-1-7)');
});
