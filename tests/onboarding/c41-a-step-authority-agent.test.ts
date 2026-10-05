// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent paths of a step result's authority after the onboarding lock
// (C41-A): what a delegation draws on, and an API-2 credential, asked again
// once the lock is held. Each case holds the onboarding's row on a third
// connection while the agent's result waits there, and moves the authority
// meanwhile: the delegating person's covering grant lapses, the delegation is
// revoked for lost authority, the credential lapses. Nothing is written.

import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { authorised, tokenFor } from '../api/fixture.ts';
import { agentPath, PROPOSAL } from '../api/controls-fixture.ts';
import { issueBody } from '../api/api-2-agent-credential-world.ts';
import { enrol, grantTo, type Member } from '../commands/fixture.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { issueGrant } from '../../packages/core-records/src/authority/grants.ts';
import { detail, useMoveWorld } from './c41-a-move-world.ts';
import { lockHold, pause, type Sent } from './c41-a-lock-hold.ts';

const serverUrl = databaseUrlFromEnvironment();

const SECONDS = 1000;

// eslint-disable-next-line max-lines-per-function -- one world, the races that share it
describe.skipIf(serverUrl === undefined)('C41-A agent step result authority after the lock', () => {
  const { the, as, onboard, revisionOf } = useMoveWorld('c41aagent');
  const { onboardingOf, stepWorld, whileHeld } = lockHold(the);

  beforeAll(async () => {
    const { db, business } = the.controls.fixture;
    await db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, the.admin, 'write', { kind: 'business', id: null }, false, 'credential');
    });
  });

  /** A person whose task authority is the fixture decider's five grants, each lapsing at `ends`. */
  const delegator = async (ends: Date): Promise<Member> => {
    const { db, business } = the.controls.fixture;
    const member = await enrol(db.app, business, 'step-delegator');
    await db.app.withBusiness(business, async (tx) => {
      for (const action of ['read', 'write', 'decide', 'assign', 'comment'] as const) {
        // oxlint-disable-next-line no-await-in-loop -- issueGrant reads the granter's rows
        const issued = await issueGrant(tx, [], {
          subject: { kind: 'person', id: member.personId },
          scope: { kind: 'business', id: null },
          collection: 'task',
          action,
          parentGrantId: null,
          grantedByActorId: the.admin.actorId,
          expiresAt: ends,
        });
        if (!issued.ok) throw new Error(issued.refusal.code);
      }
    });
    return member;
  };

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

  const byAgent = async (taskId: string, credential: string): Promise<Sent> => ({
    path: agentPath('onboarding.step_result'),
    body: { operationId: randomUUID(), recordId: taskId, outcome: 'done', result: 'by the agent' },
    headers: {
      ...authorised(await tokenFor(the.controls.fixture.agent.subject)),
      'x-agent-delegation': credential,
    },
  });

  it('C41-A races: the delegating person’s one covering grant lapsing while the agent’s step result waits on the onboarding lock narrows it, writing nothing', async () => {
    const steps = await onboard('Made-up Client Delegator Lapse');
    const welcome = String(steps.get('welcome-email'));
    const tasks = [...steps.values()];
    const { onboardingId } = await onboardingOf(welcome);
    const ends = new Date(Date.now() + 8 * SECONDS);
    const credential = await delegatedOn(welcome, await delegator(ends), 'step_lapse');
    const before = await stepWorld(tasks);
    const answer = await whileHeld(onboardingId, await byAgent(welcome, credential), async () => {
      await pause(ends.getTime() - Date.now() + SECONDS);
    });
    expect(answer.body['code'], JSON.stringify(answer.body)).toBe('DELEGATION_NARROWED');
    expect(answer.status).toBeGreaterThanOrEqual(400);
    expect(await stepWorld(tasks)).toStrictEqual(before);
  }, 60_000);

  it('C41-A races: a delegation revoked for lost authority while its agent’s step result waits on the onboarding lock answers DELEGATION_NARROWED, writing nothing', async () => {
    const steps = await onboard('Made-up Client Authority Lost');
    const welcome = String(steps.get('welcome-email'));
    const tasks = [...steps.values()];
    const { onboardingId } = await onboardingOf(welcome);
    const credential = await delegatedOn(welcome, the.admin, 'step_lost');
    const before = await stepWorld(tasks);
    const answer = await whileHeld(onboardingId, await byAgent(welcome, credential), async () => {
      // What a revocation's classification records when the delegating person
      // lost the authority the delegation drew on, committed during the wait.
      await the.controls.fixture.db.admin.execute(
        `update public.delegations set revoked_at = now(), revocation_cause = 'authority_lost'
          where purpose_scope_id = $1 and revoked_at is null`,
        [welcome],
      );
    });
    expect(answer.body['code'], JSON.stringify(answer.body)).toBe('DELEGATION_NARROWED');
    expect(await stepWorld(tasks)).toStrictEqual(before);
  }, 60_000);

  it('C41-A races: an API-2 credential that lapses while its step result waits on the onboarding lock is refused, writing nothing', async () => {
    const steps = await onboard('Made-up Client Credential Lapse');
    const welcome = String(steps.get('welcome-email'));
    const tasks = [...steps.values()];
    const { onboardingId } = await onboardingOf(welcome);
    // A credential is written once: it is issued to lapse four seconds on.
    const issued = await as(
      the.admin,
      'credential.issue',
      issueBody({ expiresAt: new Date(Date.now() + 4 * SECONDS).toISOString() }),
    );
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    const before = await stepWorld(tasks);
    const first: Sent = {
      path: agentPath('onboarding.step_result'),
      body: { operationId: randomUUID(), recordId: welcome, outcome: 'done', result: 'lapsed' },
      headers: authorised(String(detail(issued)['credential'])),
    };
    const answer = await whileHeld(onboardingId, first, async () => {
      await pause(4500);
    });
    expect([answer.status, answer.body['code']]).toStrictEqual([401, 'DELEGATION_NOT_LIVE']);
    expect(await stepWorld(tasks)).toStrictEqual(before);
  }, 60_000);
});
