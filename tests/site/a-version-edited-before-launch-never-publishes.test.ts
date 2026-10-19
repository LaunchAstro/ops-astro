// SPDX-License-Identifier: AGPL-3.0-only
//
// #1693, gap 2: a version whose page is edited between its stamp and its
// publish never publishes. Launch reads the runner's last check, at most 60 s
// old; the effect is settled at the publish's advance of the default branch,
// a fast-forward from the approved base that refuses once any commit landed
// after every check. On a real
// database, the runner's locate and its proposal and publish run over a
// double of the repository (each commit's files and the default branch's
// head) and the providers' double (every request kept):
// - an edit inside the bound with no locate pass between: Launch is accepted,
//   and the runner's head check before its first write stops the run with
//   nothing sent and one person task;
// - a locate pass between the edit and Launch supersedes the version, and
//   Launch is refused with the row untouched;
// - an edit landing after every check and just before the publish's advance is
//   refused as not a fast-forward, nothing applied, and read back unknown
//   with one person task;
// - an edit to another file after the pin leaves the version fresh, but the
//   default branch has moved from its base, so the read back before the send
//   stops it with nothing sent and one person task (re-pinning at Accept is
//   #2101).
// The design's table also names a review before Launch: there is no review
// command (only `live_correction.decide`), so no case calls one.
/* eslint-disable max-lines-per-function -- each case keeps its stamp, edit, Launch and run in one place */

import { beforeEach, describe, expect, it } from 'vitest';
import { codeOf } from '../commands/agent-fixture.ts';
import { contentDigest } from '../../packages/core-connectors/src/index.ts';
import { BEFORE, PAGE } from './c80-world.ts';
import { receipt, serverUrl, w } from './c80-register-world.ts';
import { dueNow, HEAD_COMMIT, locateOnce, noneWaiting, requestOn, rowOf } from './locate-world.ts';
import { merges, runnerOn, useRunnerWorld, writes } from './site-runner-world.ts';
import {
  commitOnMain,
  CONTACT,
  EDITED,
  editAbout,
  edited,
  OTHER,
  type Edited,
} from './edited-site-world.ts';

useRunnerWorld();

/** Requested through the door, then pinned and stamped by one locate pass (t0). */
async function stamped(given: Edited): Promise<{ id: string; versionId: string }> {
  const id = await requestOn(PAGE);
  expect(await locateOnce(given.locate)).toEqual([{ correctionId: id, outcome: 'requested' }]);
  const row = await rowOf(id);
  expect(row).toMatchObject({
    state: 'requested',
    base_revision: HEAD_COMMIT,
    pre_image_digest: contentDigest(BEFORE),
  });
  return { id, versionId: String(row.version_id) };
}

const launch = async (id: string, versionId: string) => await w.approve(w.ben, id, versionId);

const revisionOf = async (id: string): Promise<string | undefined> =>
  (
    await w.world.db.admin.execute<{ readonly v: string }>(
      'select revision::text as v from public.live_corrections where id = $1',
      [id],
    )
  )[0]?.v;

beforeEach(async () => {
  if (serverUrl !== undefined) await noneWaiting();
});

describe.skipIf(serverUrl === undefined)('a version edited before Launch never publishes', () => {
  it('accepts Launch inside the bound on a page edited since its stamp, and the runner sends nothing', async () => {
    const given = edited();
    const { id, versionId } = await stamped(given);
    // t1: the page is edited, and no locate pass runs before Launch.
    editAbout(given, EDITED);
    expect(codeOf(await launch(id, versionId))).toBe('not-a-refusal');
    expect(await w.stateOf(id)).toBe('approved');

    const { runner, released } = runnerOn(id, given.world);
    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'CONTENT_DRIFTED' }]);
    // The head read afresh before the first write finds the edit: not one write left.
    expect(writes(given.world.site)).toEqual([]);
    expect(given.world.site.state.content).toBe(EDITED);
    expect(given.world.raised).toEqual(['CONTENT_DRIFTED']);
    expect(released).toEqual([id]);
    // The design's table says `failed CONTENT_DRIFTED`. The code stops at the proposal step,
    // before the dispatch is taken, so nothing records a state: the correction stays approved,
    // and the lease is handed back failed with CONTENT_DRIFTED as its report (claims.ts).
    expect(await w.stateOf(id)).toBe('approved');
  });

  it('supersedes the version at the next locate pass, and Launch is then refused with the row untouched', async () => {
    const given = edited();
    const { id, versionId } = await stamped(given);
    editAbout(given, EDITED);
    // The next pass, brought forward from 15 s after the stamp.
    await dueNow(id);
    expect(await locateOnce(given.locate)).toEqual([
      { correctionId: id, outcome: 'CONTENT_DRIFTED' },
    ]);
    expect(await rowOf(id)).toMatchObject({
      state: 'superseded',
      locate_code: 'CONTENT_DRIFTED',
      version_id: versionId,
    });

    const revision = await revisionOf(id);
    expect(codeOf(await launch(id, versionId))).toBe('VERSION_NOT_READY');
    const rejected = await w.as(w.ben, {
      command: 'live_correction.decide',
      correctionId: id,
      versionId,
      decision: 'reject',
    });
    expect(codeOf(rejected)).toBe('VERSION_NOT_READY');
    expect(await revisionOf(id)).toBe(revision);
    expect(await w.stateOf(id)).toBe('superseded');
    expect(writes(given.world.site)).toEqual([]);
    expect(given.locate.requests.every((asked) => asked.startsWith('GET '))).toBe(true);
  });

  it('never applies the publish when the page is edited after every check and before the advance', async () => {
    const given = edited();
    const { id, versionId } = await stamped(given);
    expect(codeOf(await launch(id, versionId))).toBe('not-a-refusal');
    // The edit lands after the head check and the publish's own reads, just before its advance.
    given.beforePublish.edit = () => {
      editAbout(given, EDITED);
    };

    const { runner, released } = runnerOn(id, given.world);
    const passed = await runner.pass();

    // One advance of the default branch, refused as not a fast-forward: it applied nothing.
    expect(merges(given.world.site)).toHaveLength(1);
    expect(given.published).toEqual([422]);
    expect(given.world.site.state.content).toBe(EDITED);
    expect(given.world.site.state.mainHead).toBe(given.repository.head);
    expect(released).toEqual([id]);
    // The design's table says `failed`. The code reads the refusal back (`reconciled`): the
    // default branch's head is neither the proposal's nor the base, so nothing proves the advance
    // absent and the publish is recorded unknown, waiting on a person.
    expect(passed).toEqual([{ correctionId: id, outcome: 'unknown' }]);
    expect(await w.stateOf(id)).toBe('unknown');
    expect(given.world.raised).toEqual(['RECONCILE_UNPROVEN']);
    const publish = await receipt(id, 'publish');
    expect(publish['waits_on']?.observed).toBe('person');
    expect(publish['unknown_outcome_reconciliation']?.observed).toContain('RECONCILE_UNPROVEN');
  });

  it('keeps a version fresh when another file is edited after the pin, and never advances it from a moved base', async () => {
    const given = edited();
    const { id, versionId } = await stamped(given);
    const { verified_at: stampedAt } = await rowOf(id);
    commitOnMain(given, { [OTHER]: `${CONTACT}\nOpen on weekdays.\n` });
    expect(given.repository.head).not.toBe(HEAD_COMMIT);

    // The next pass reads the new head: the page's file is as pinned, so it is stamped again.
    await dueNow(id);
    expect(await locateOnce(given.locate)).toEqual([]);
    const row = await rowOf(id);
    expect(row).toMatchObject({
      state: 'requested',
      base_revision: HEAD_COMMIT,
      version_id: versionId,
    });
    expect(row.verified_at).not.toBe(stampedAt);

    expect(codeOf(await launch(id, versionId))).toBe('not-a-refusal');
    const { runner } = runnerOn(id, given.world);
    // The default branch is no longer the pinned base. The read back before the send already finds
    // its head neither the proposal's nor the base, so it stops there: nothing is sent, and the
    // person's task reads RECONCILE_UNPROVEN, never reaching the publish's BASE_MOVED check.
    expect(await runner.pass()).toEqual([{ correctionId: id, outcome: 'unknown' }]);
    expect(merges(given.world.site)).toEqual([]);
    expect(given.published).toEqual([]);
    expect(given.world.site.state.content).toBe(BEFORE);
    expect(given.world.raised).toEqual(['RECONCILE_UNPROVEN']);
  });
});
