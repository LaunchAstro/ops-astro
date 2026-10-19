// SPDX-License-Identifier: AGPL-3.0-only
//
// #1624 R7 (#1716, Sol's coverage on #2010): the correction the shipped agent
// runner drafts goes the way a person's does after the request. The M5's
// runner, configured for the business's own site, finds it in its due list
// and pins it with its own write (`pinLocated`, #1693) from the file it read
// at a 40-hex revision; then the owner's review read (`live_correction.read`)
// answers it `requested` with that version, ready for their decision. The
// runner's locate pass itself, which calls these writes, lands in #1924, and
// the review list after a reload in #1694.

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { agentRunner } from '../../apps/worker/agent-runner.ts';
import { executeRead } from '../../packages/core-commands/src/index.ts';
import {
  contentDigest,
  replaced,
  REPLAY_TURN,
  versionDigestOf,
} from '../../packages/core-connectors/src/index.ts';
import {
  dueCorrections,
  pinLocated,
  type ConfiguredSite,
  type LocatedPin,
} from '../../packages/core-records/src/site/locate.ts';
import { acceptedPlan } from './compute-seam-world.ts';
import {
  agentBroker,
  correctionsOn,
  OWN_PAGE,
  ownSiteOf,
  replied,
  requestOf,
  type CorrectionRow,
} from './agent-draft-world.ts';
import { s, useStopWorld, world } from './run-stop-world.ts';

useStopWorld('r7agentpin');

let site: ConfiguredSite;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  site = await ownSiteOf(s, OWN_PAGE);
}, 180_000);

/** The about page's file at the revision the runner read, with the misspelt town in it. */
const BEFORE = '---\ntitle: About\n---\n\nWe are a Townsvile studio.\n';
const REVISION = `5eed${'0'.repeat(36)}`;

/** The pin the runner computes for `row` from `BEFORE` at `REVISION`. */
function pinOf(row: CorrectionRow & { readonly seam: string; readonly target_path: string }) {
  const target = { path: row.target_path, word: row.word, replacement: row.replacement };
  const after = replaced(BEFORE, row.word, row.replacement);
  if (after === undefined) throw new Error('setup: the word is not in the file');
  const preImageDigest = contentDigest(BEFORE);
  const versionDigest = versionDigestOf({
    target,
    change: { files: [{ path: row.target_path, before: BEFORE, after }] },
    preImageDigest,
    baseRevision: REVISION,
    pageUrl: row.page_url,
    seam: row.seam,
  });
  return {
    id: row.id,
    versionId: randomUUID(),
    baseRevision: REVISION,
    preImageDigest,
    versionDigest,
  } satisfies LocatedPin;
}

describe.skipIf(serverUrl === undefined)("the agent's correction after the request", () => {
  it('is due to the M5, pinned by its write, and reviewed by the owner at that version', async () => {
    const seam = await acceptedPlan(
      'the about page spells the town wrong',
      agentRunner({ operation: REPLAY_TURN.key }),
      agentBroker(),
    );
    const ask = { id: 'call_1', name: 'live_correction.request', args: requestOf(seam.taskId) };
    world.provider.script([replied('Asking.', [ask]), replied('Drafted for your decision.')]);
    const outcome = await seam.worker.applyOnce(seam.taskId);
    expect(outcome, JSON.stringify(outcome)).toHaveProperty('handedBack');
    const [drafted] = await correctionsOn(seam.taskId);
    if (drafted === undefined) throw new Error('the agent drafted nothing');

    const pinned = await s.db.app.withBusiness(s.business, async (tx) => {
      const due = await dueCorrections(tx, site.holder);
      expect(due.find((each) => each.id === drafted.id)).toMatchObject({
        state: 'locating',
        pageUrl: OWN_PAGE,
        word: drafted.word,
        replacement: drafted.replacement,
        site: { repository: site.repository, project: site.project },
      });
      const [row] = await tx.query<CorrectionRow & { seam: string; target_path: string }>(
        `select id::text as id, page_url, word, replacement, seam, target_path
           from public.live_corrections where business_id = $1 and id = $2`,
        [s.business, drafted.id],
      );
      if (row === undefined) throw new Error('the correction is not in this business');
      const pin = pinOf(row);
      expect(await pinLocated(tx, site, pin)).toBe('pinned');
      return pin;
    });

    const read = await executeRead(s.db.app, s.business, s.decider.presented, {
      read: 'live_correction.read',
      correctionId: drafted.id,
    });
    expect(read).toMatchObject({
      ok: true,
      correction: { correctionId: drafted.id, state: 'requested', versionId: pinned.versionId },
    });
  }, 120_000);
});
