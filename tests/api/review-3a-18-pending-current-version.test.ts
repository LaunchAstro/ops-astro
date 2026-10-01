// SPDX-License-Identifier: AGPL-3.0-only
//
// REVIEW-3A-18: `gate.pending` lists current versions only, proved by
// superseding one. The MP-6-1 case "lists every pending gate to a
// business-wide decider, current versions only"
// (tests/api/mp-6-1-isolation.test.ts) never revises a proposal, so a read
// that listed a superseded version's gate beside its successor's would pass
// it. Here a lineage is revised through `task.propose` and the list must name
// the new version's gate, once, and not the old one.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createControls, detailOf, PROPOSAL, type Controls } from './controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

describe.skipIf(serverUrl === undefined)('REVIEW-3A-18 gate.pending', () => {
  let c: Controls;

  beforeAll(async () => {
    c = await createControls('review_3a_18');
  }, 180_000);

  afterAll(async () => await c?.drop());

  const awaiting = async () => {
    const answer = await c.asPerson('gate.pending', {});
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    return answer.body['awaiting'] as {
      gateId: string;
      versionId: string;
      taskId: string;
      version: number;
    }[];
  };

  it('REVIEW-3A-18: a revised proposal lists only its current version’s gate, never the superseded one', async () => {
    const task = await c.createTask('REVIEW-3A-18 revised');
    const purpose = 'review_3a_18';
    const first = await c.propose(task.id, task.revision, purpose);
    expect((await awaiting()).map((row) => row.gateId)).toContain(first['gateId']);

    const revision = await c.count(
      `select revision::text as n from public.records where business_id = $1 and id = $2`,
      [c.fixture.business, task.id],
    );
    const revised = await c.asPerson('task.propose', {
      recordId: task.id,
      expectedRevision: revision,
      ...PROPOSAL,
      purpose,
      lineageId: first['lineageId'],
    });
    expect(revised.status, JSON.stringify(revised.body)).toBe(200);
    const second = detailOf(revised);
    expect(second['gateId']).not.toBe(first['gateId']);

    const rows = await awaiting();
    const gates = rows.map((row) => row.gateId);
    expect(gates, 'the superseded version’s gate is still offered').not.toContain(first['gateId']);
    expect(gates).toContain(second['gateId']);
    expect(rows.filter((row) => row.taskId === task.id)).toEqual([
      expect.objectContaining({
        gateId: second['gateId'],
        versionId: second['versionId'],
        version: 2,
      }),
    ]);
  });
});
