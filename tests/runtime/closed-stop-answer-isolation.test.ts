// SPDX-License-Identifier: AGPL-3.0-only
//
// The answers to a budget stop raised on a closed hold, crossed. Each stop
// here is the no-room stop of `unsent-call-on-a-closed-hold`: the first hold
// closed at its spend by its ended lease with a call reserved and never sent,
// so a top-up that applies releases that call uncounted (`releaseUncounted`)
// and holds afresh. Every crossing below names a stop it may not answer, or
// answers as a caller who may not, through the command entry a person or an
// agent reaches, and then reads that nothing of the other side moved: its
// calls, holds, asks, answers, approvals and envelope.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { codeOf } from './schedules-harness.ts';
import { callState } from './version-room-world.ts';
import {
  agentAnswers,
  answerBody,
  answerCodes,
  asMember,
  delegationOn,
  ledgerOf,
  linkClient,
  memberOn,
  openCrossings,
  sameAsMadeUp,
  type Crossings,
} from './closed-stop-answer-world.ts';

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'runtime/closed-stop-answer-isolation: DATABASE_URL is unset, so nothing below ran.',
  );
}

let w: Crossings;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await openCrossings();
}, 180_000);

afterAll(async () => {
  await w?.alpha.db.drop();
});

const four = (code: string): readonly string[] => Array.from({ length: 4 }, () => code);

describe.skipIf(serverUrl === undefined)('a stop on a closed hold, across businesses', () => {
  it("a top-up in one business moves nothing of another business's stop, and naming that stop answers as a made-up one", async () => {
    const { alpha, bravo, a1, b1 } = w;
    const before = await ledgerOf(bravo, b1.work.taskId);
    const body = answerBody('run.top_up', a1.work.taskId, a1.runId, a1.askId);
    const topped = await asMember(alpha, alpha.decider, body);
    expect({ code: codeOf(topped), unsent: await callState(alpha, a1.unsent) }).toEqual({
      code: 'applied',
      unsent: 'released',
    });

    const underOwnTask = await sameAsMadeUp(alpha, alpha.decider, a1.work.taskId, b1);
    const underTheirTask = await sameAsMadeUp(alpha, alpha.decider, b1.work.taskId, b1);
    expect([...underOwnTask, ...underTheirTask]).toEqual(four('NOT_FOUND'));
    expect(await callState(bravo, b1.unsent)).toBe('reserved');
    expect(await ledgerOf(bravo, b1.work.taskId)).toStrictEqual(before);
  });
});

describe.skipIf(serverUrl === undefined)('a stop on a closed hold, across clients', () => {
  it("a person who may answer one client's task cannot answer another client's stop, under either task", async () => {
    const { alpha, clientA, clientB } = w;
    // A client's task makes no model call (C60) and a task with work takes no
    // client change (S0-5), so the links are written as `task.set_party`
    // stores them, after both stops stand.
    const links = [
      await linkClient(alpha, clientA.work.taskId),
      await linkClient(alpha, clientB.work.taskId),
    ];
    expect(links.every((link) => link !== null)).toBe(true);
    expect(links[0]).not.toBe(links[1]);
    const forA = await memberOn(alpha, 'client_a_decider', clientA.work.taskId);
    const ledgers = async (): Promise<unknown> => ({
      a: await ledgerOf(alpha, clientA.work.taskId),
      b: await ledgerOf(alpha, clientB.work.taskId),
    });
    const before = await ledgers();

    const underOwnTask = await sameAsMadeUp(alpha, forA, clientA.work.taskId, clientB);
    const underTheirTask = await sameAsMadeUp(alpha, forA, clientB.work.taskId, clientB);
    expect({ underOwnTask, underTheirTask }).toEqual({
      underOwnTask: ['NOT_FOUND', 'NOT_FOUND'],
      underTheirTask: ['SCOPE_NOT_GRANTED', 'SCOPE_NOT_GRANTED'],
    });
    expect(await callState(alpha, clientB.unsent)).toBe('reserved');
    expect(await ledgers()).toStrictEqual(before);
  });
});

describe.skipIf(serverUrl === undefined)('a stop on a closed hold, across people', () => {
  it('a person granted on another task only, and a person with no grant, answer this stop with nothing written', async () => {
    const { alpha, clientA, clientB } = w;
    const elsewhere = await memberOn(alpha, 'granted_elsewhere', clientB.work.taskId);
    const nobody = await memberOn(alpha, 'granted_nothing', null);
    const before = await ledgerOf(alpha, clientA.work.taskId);

    const codes = [
      ...(await answerCodes(alpha, elsewhere, clientA)),
      ...(await answerCodes(alpha, nobody, clientA)),
    ];
    expect(codes).toEqual(four('SCOPE_NOT_GRANTED'));
    expect(await callState(alpha, clientA.unsent)).toBe('reserved');
    expect(await ledgerOf(alpha, clientA.work.taskId)).toStrictEqual(before);
  });
});

describe.skipIf(serverUrl === undefined)('a stop on a closed hold, answered by an agent', () => {
  it("an agent under a delegation covering the task cannot answer the task's stop, by the command or the runtime", async () => {
    const { alpha, agentStop } = w;
    const live = await delegationOn(alpha, agentStop.work.taskId);
    const before = await ledgerOf(alpha, agentStop.work.taskId);

    expect(await agentAnswers(alpha, agentStop, String(live['credential']))).toEqual({
      commands: ['DELEGATION_EXCLUDES_OPERATION', 'DELEGATION_EXCLUDES_OPERATION'],
      runtime: 'DELEGATION_EXCLUDES_DECISION',
    });
    expect(await callState(alpha, agentStop.unsent)).toBe('reserved');
    expect(await ledgerOf(alpha, agentStop.work.taskId)).toStrictEqual(before);
  });
});

describe.skipIf(serverUrl === undefined)('a stop on a closed hold, named by a foreign ask', () => {
  it("a person who may answer their own stop, naming another run's ask, is refused with nothing written on either run", async () => {
    const { alpha, clientA, clientB } = w;
    const ledgers = async (): Promise<unknown> => ({
      own: await ledgerOf(alpha, clientA.work.taskId),
      other: await ledgerOf(alpha, clientB.work.taskId),
    });
    const before = await ledgers();

    expect(await answerCodes(alpha, alpha.decider, clientA, clientB.askId)).toEqual([
      'TRANSITION_NOT_PERMITTED',
      'TRANSITION_NOT_PERMITTED',
    ]);
    expect({
      own: await callState(alpha, clientA.unsent),
      other: await callState(alpha, clientB.unsent),
    }).toEqual({ own: 'reserved', other: 'reserved' });
    expect(await ledgers()).toStrictEqual(before);
  });
});
