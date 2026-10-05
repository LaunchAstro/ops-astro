// SPDX-License-Identifier: AGPL-3.0-only
//
// A step result's authority is asked again once the onboarding's lock is held
// (C41-A, the checklist's "grants, delegations and expiry are checked again,
// under the lock, when the effect applies"). Each case holds the onboarding's
// row `for update` on a third connection, so the result waits there after the
// envelope's check, and the authority moves meanwhile: a committed grant
// revocation, a covering grant that lapses, a delegation that lapses. Every
// call runs on its own server instance and connection, as two requests on two
// serverless instances do.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authorised, tokenFor, type Answer } from '../api/fixture.ts';
import { agentPath } from '../api/controls-fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { useMoveWorld } from './c41-a-move-world.ts';
import { byPerson, lockHold, pause, type Sent } from './c41-a-lock-hold.ts';

const serverUrl = databaseUrlFromEnvironment();

// eslint-disable-next-line max-lines-per-function -- one world, the races that share it
describe.skipIf(serverUrl === undefined)('C41-A step result authority after the lock', () => {
  const { the, onboard, revisionOf } = useMoveWorld('c41aauth');
  const { onboardingOf, writerOn, stepWorld, whileHeld, waiters } = lockHold(the);

  it('C41-A races: a revocation of the writer’s one covering grant, made while the step result waits on the onboarding lock, waits for that result', async () => {
    const steps = await onboard('Made-up Client Revoke Race');
    const welcome = String(steps.get('welcome-email'));
    const { onboardingId, clientId } = await onboardingOf(welcome);
    const { member, grantId } = await writerOn(clientId);
    const first = await byPerson(member, 'onboarding.step_result', {
      recordId: welcome,
      outcome: 'done',
      result: 'revoked writer result',
    });
    let revoked: Promise<Answer> | undefined;
    let raced = '';
    const answer = await whileHeld(onboardingId, first, async (send) => {
      const revocation = send(await byPerson(the.admin, 'grant.revoke', { grantId }));
      revoked = revocation;
      // Committed now, or waiting on the grant row the result holds.
      raced = await Promise.race([
        revocation.then(() => 'committed'),
        waiters(2).then((seen) => (seen ? 'waiting' : 'neither')),
      ]);
    });
    const revocation = await (revoked as Promise<Answer>);
    expect(raced).toBe('waiting');
    expect(answer.status, JSON.stringify(answer.body)).toBe(200);
    expect(revocation.status, JSON.stringify(revocation.body)).toBe(200);
    const [rows] = await stepWorld([welcome, String(steps.get('kickoff-call'))]);
    expect(rows).toMatchObject([
      { step_key: 'welcome-email', state: 'done', comments: '1' },
      { step_key: 'kickoff-call', state: 'ready' },
    ]);
  }, 60_000);

  it('C41-A races: a writer whose one covering grant lapses while the step result waits on the onboarding lock is refused, writing nothing', async () => {
    const steps = await onboard('Made-up Client Lapse Race');
    const welcome = String(steps.get('welcome-email'));
    const tasks = [...steps.values()];
    const { onboardingId, clientId } = await onboardingOf(welcome);
    const { member } = await writerOn(clientId, new Date(Date.now() + 3000));
    const before = await stepWorld(tasks);
    const first = await byPerson(member, 'onboarding.step_result', {
      recordId: welcome,
      outcome: 'done',
      result: 'lapsed writer result',
    });
    const answer = await whileHeld(onboardingId, first, async () => {
      await pause(3500);
    });
    expect([answer.status, answer.body['code']]).toStrictEqual([403, 'SCOPE_NOT_GRANTED']);
    expect(await stepWorld(tasks)).toStrictEqual(before);
  }, 60_000);

  it('C41-A races: a delegation that lapses while its agent’s step result waits on the onboarding lock is refused, writing nothing', async () => {
    const steps = await onboard('Made-up Client Delegation Lapse');
    const welcome = String(steps.get('welcome-email'));
    const tasks = [...steps.values()];
    const { onboardingId } = await onboardingOf(welcome);
    const { controls } = the;
    const proposal = await controls.propose(welcome, await revisionOf(welcome), 'step_welcome');
    const credential = String(
      (await controls.pickup(await controls.approve(proposal)))['credential'],
    );
    await controls.fixture.db.admin.execute(
      `update public.delegations set expires_at = clock_timestamp() + interval '3 seconds'
        where purpose_scope_id = $1 and revoked_at is null`,
      [welcome],
    );
    const before = await stepWorld(tasks);
    const first: Sent = {
      path: agentPath('onboarding.step_result'),
      body: { operationId: randomUUID(), recordId: welcome, outcome: 'done', result: 'lapsed' },
      headers: {
        ...authorised(await tokenFor(controls.fixture.agent.subject)),
        'x-agent-delegation': credential,
      },
    };
    const answer = await whileHeld(onboardingId, first, async () => {
      await pause(3500);
    });
    expect([answer.status, answer.body['code']]).toStrictEqual([401, 'DELEGATION_NOT_LIVE']);
    expect(await stepWorld(tasks)).toStrictEqual(before);
  }, 60_000);
});
