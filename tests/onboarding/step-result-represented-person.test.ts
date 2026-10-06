// SPDX-License-Identifier: AGPL-3.0-only
//
// Catalogue #414 on the onboarding step result (C41-A): an agent's result,
// and the report a second failure adds, record the person its delegation
// acts for, and an API-2 credential's result records the credential's
// person, as every other agent comment does. One agent actor writes for many
// people, so without it the comment does not say whose words it holds.

import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { authorised, post, tokenFor, type Answer } from '../api/fixture.ts';
import { agentPath, PROPOSAL } from '../api/controls-fixture.ts';
import { issueBody } from '../api/api-2-agent-credential-world.ts';
import { grantTo, type Member } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { detail, useMoveWorld } from './c41-a-move-world.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, the agent and credential paths
describe.skipIf(serverUrl === undefined)('C41-A step result: the represented person', () => {
  const { the, as, onboard, revisionOf } = useMoveWorld('c41aonbehalf');

  beforeAll(async () => {
    const { db, business } = the.controls.fixture;
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, the.admin, 'write', { kind: 'business', id: null }, false, 'credential');
    });
  });

  /** The agent picked up on a step's task under a delegation `by` decided. */
  const delegatedOn = async (taskId: string, by: Member, purpose: string): Promise<string> => {
    const { controls } = the;
    const proposed = await controls.asPerson(
      'task.propose',
      { recordId: taskId, expectedRevision: await revisionOf(taskId), ...PROPOSAL, purpose },
      by,
    );
    expect(proposed.status, JSON.stringify(proposed.body)).toBe(200);
    const decided = await controls.asPerson(
      'task.decide',
      {
        gateId: detail(proposed)['gateId'],
        versionId: detail(proposed)['versionId'],
        decision: 'approve',
        note: 'approved so the agent records the step',
      },
      by,
    );
    expect(decided.status, JSON.stringify(decided.body)).toBe(200);
    return String((await controls.pickup(String(detail(decided)['reservationId'])))['credential']);
  };

  const result = async (
    taskId: string,
    outcome: 'done' | 'failed',
    headers: Readonly<Record<string, string>>,
  ): Promise<Answer> =>
    await post(
      the.controls.api,
      agentPath('onboarding.step_result'),
      { operationId: randomUUID(), recordId: taskId, outcome, result: `${outcome} by the agent` },
      headers,
    );

  /** Every comment on the task, oldest first: its body and the person it records. */
  const comments = async (
    taskId: string,
  ): Promise<readonly { readonly body: string; readonly person: string | null }[]> =>
    await the.controls.fixture.db.admin.execute(
      `select data ->> 'body' as body, data ->> 'on_behalf_of' as person
         from public.records
        where data ->> 'task' = $1 and data ? 'comment_type'
        order by created_at, data ->> 'posted_at'`,
      [taskId],
    );

  it('#414 an agent’s step results and the stop report record the person its delegation acts for', async () => {
    const steps = await onboard('Made-up Client Represented Agent');
    const welcome = String(steps.get('welcome-email'));
    const credential = await delegatedOn(welcome, the.admin, 'step_on_behalf');
    const headers = {
      ...authorised(await tokenFor(the.controls.fixture.agent.subject)),
      'x-agent-delegation': credential,
    };
    for (const attempt of [1, 2]) {
      // oxlint-disable-next-line no-await-in-loop -- the second failure follows the first
      const answer = await result(welcome, 'failed', headers);
      expect(answer.status, `attempt ${attempt}: ${JSON.stringify(answer.body)}`).toBe(200);
    }
    const written = await comments(welcome);
    expect(written.some((one) => /stopped after two failed attempts/iu.test(one.body))).toBe(true);
    expect(written.length).toBeGreaterThanOrEqual(3);
    expect(written.map((one) => one.person)).toStrictEqual(written.map(() => the.admin.personId));
  }, 60_000);

  it('#414 an API-2 credential’s step result records the credential’s person', async () => {
    const steps = await onboard('Made-up Client Represented Credential');
    const welcome = String(steps.get('welcome-email'));
    const issued = await as(the.admin, 'credential.issue', issueBody());
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const answer = await result(welcome, 'done', authorised(String(detail(issued)['credential'])));
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    const written = await comments(welcome);
    expect(written.map((one) => one.person)).toStrictEqual([the.admin.personId]);
  }, 60_000);
});
