// SPDX-License-Identifier: AGPL-3.0-only
//
// `AW-09 no self-review`: the agent can never complete its own review round,
// on any surface and in the runtime itself. The output is real: an approved
// plan the agent picked up and handed back with a successor (the reviewed
// output, AW-08).
//
// - On the agent prefix, under the delegation its own pickup minted and under
//   a live one, no decision applies; under the live one it is
//   `DELEGATION_EXCLUDES_DECISION`.
// - Its own login on the person entry points (app, API, command line) is
//   refused before any authority is asked.
// - The runtime's `decide` is asked directly with the agent's actor beside a
//   person who holds decide, the one way past the surfaces' identity checks:
//   each decision is refused `DELEGATION_EXCLUDES_DECISION`, and the escalate
//   too. Before AW-09 the runtime trusted the actor it was handed.
// Every refusal leaves the gate pending with no decision row. The positive
// control is the person deciding the same output as themselves.
// The process-level half (the command line holding the agent's session) is in
// `tests/cli/aw-09-reviewed-on-every-surface.test.ts`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decide, gateSigningKey } from '../../packages/core-runtime/src/index.ts';
import { isReviewedOutput } from '../../packages/core-runtime/src/reviewed-output.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { agentOutput as madeByAgent } from './aw-09-agent-round.ts';
import {
  asAgent,
  codeOf,
  openSchedules,
  rows,
  type Detail,
  type Schedules,
} from './schedules-harness.ts';
import { decideBody, SURFACES } from './t3a-support.ts';

const serverUrl = databaseUrlFromEnvironment();
const KINDS = ['approve', 'request_changes', 'reject', 'escalate'] as const;

/** The agent's output, with the credential its own pickup minted. */
async function agentOutput(s: Schedules): Promise<Detail & { readonly credential: string }> {
  const { output, work } = await madeByAgent(s);
  return { ...output, credential: String(work.picked['credential']) };
}

// eslint-disable-next-line max-lines-per-function -- every surface, then the runtime
describe.skipIf(serverUrl === undefined)('AW-09 no self-review', () => {
  let s: Schedules;

  beforeAll(async () => {
    s = await openSchedules('aw09_self', 1_000_000);
  }, 180_000);

  afterAll(async () => {
    await s?.db.drop();
  });

  const footprint = async (gateId: unknown) =>
    await rows<{ readonly state: string; readonly decisions: number }>(
      s,
      `select g.state, (select count(*)::int from public.gate_decisions d
                         where d.business_id = g.business_id and d.gate_id = g.id) as decisions
         from public.gates g where g.business_id = $1 and g.id = $2`,
      [s.business, gateId],
    );

  /** The runtime asked with `actorId` as the decider, beside the person who holds decide. */
  const runtimeDecide = async (output: Detail, kind: (typeof KINDS)[number], actorId: string) =>
    await s.db.app.withBusiness(s.business, async (tx) => {
      const signingKey = gateSigningKey();
      if (signingKey === undefined) throw new Error('no signing key');
      return await decide(tx, {
        gateId: String(output['gateId']),
        versionId: String(output['versionId']),
        decidedByPersonId: s.decider.personId,
        decidedByActorId: actorId,
        subjects: [
          { kind: 'person', id: s.decider.personId },
          { kind: 'actor', id: s.decider.actorId },
        ],
        collection: 'task',
        decision: kind,
        note: 'aw-09 self review',
        signingKey,
        capId: s.capId,
        ...(kind === 'escalate' ? { recipientPersonId: s.decider.personId } : {}),
      });
    });

  it('AW-09 no self-review: the output under test is the agent’s reviewed output', async () => {
    const output = await agentOutput(s);
    const reviewed = await s.db.app.withBusiness(s.business, (tx) =>
      isReviewedOutput(tx, String(output['versionId'])),
    );
    expect(reviewed).toBe(true);
    expect(await footprint(output['gateId'])).toEqual([{ state: 'pending', decisions: 0 }]);
  });

  it('AW-09 no self-review: the agent is refused every decision on the agent prefix, under its spent pickup and a live delegation', async () => {
    const output = await agentOutput(s);
    // A body each, so neither answer is the other's replay.
    const bodyFor = (kind: string) => ({
      ...decideBody(output, kind),
      ...(kind === 'escalate' ? { recipientPersonId: s.decider.personId } : {}),
    });
    for (const kind of KINDS) {
      // The pickup's own credential is spent by the handback; a live one is
      // refused the decision itself.
      // eslint-disable-next-line no-await-in-loop -- one refusal at a time
      expect(codeOf(await asAgent(s, bodyFor(kind), output.credential))).not.toBe('applied');
      // eslint-disable-next-line no-await-in-loop -- one refusal at a time
      expect(codeOf(await asAgent(s, bodyFor(kind), String(output['delegation'])))).toBe(
        'DELEGATION_EXCLUDES_DECISION',
      );
    }
    expect(await footprint(output['gateId'])).toEqual([{ state: 'pending', decisions: 0 }]);
  });

  it('AW-09 no self-review: the agent’s own login is refused on the app, the API and the command line entry points', async () => {
    const output = await agentOutput(s);
    for (const surface of SURFACES) {
      // eslint-disable-next-line no-await-in-loop -- one entry point at a time
      const result = await executeCommand(
        s.db.app,
        s.business,
        s.agent,
        surface,
        decideBody(output, 'approve') as never,
      );
      expect(codeOf(result), surface).not.toBe('applied');
    }
    expect(await footprint(output['gateId'])).toEqual([{ state: 'pending', decisions: 0 }]);
  });

  it('AW-09 no self-review: the runtime refuses the agent’s actor as the decider of its own output, writing nothing', async () => {
    const output = await agentOutput(s);
    for (const kind of KINDS) {
      // eslint-disable-next-line no-await-in-loop -- each decision on the same pending gate
      const result = await runtimeDecide(output, kind, s.agentActorId);
      expect(result.ok, kind).toBe(false);
      if (!result.ok) expect(result.refusal.code, kind).toBe('DELEGATION_EXCLUDES_DECISION');
    }
    expect(await footprint(output['gateId'])).toEqual([{ state: 'pending', decisions: 0 }]);

    // Positive control: the person deciding as themselves completes the round.
    const decided = await runtimeDecide(output, 'request_changes', s.decider.actorId);
    expect(decided.ok).toBe(true);
    expect(await footprint(output['gateId'])).toEqual([
      { state: 'changes_requested', decisions: 1 },
    ]);
  });
});
