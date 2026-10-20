// SPDX-License-Identifier: AGPL-3.0-only
//
// #1904 P15 (design v3, "Who may read which part"): an instruction file's
// content goes only where the design lets it: the read's answer, the turn's
// request, the call's transaction and the attempt's own store. A marker
// planted in the run's file reaches the provider's request (a), and is in no
// agent-door register row, for the read or its replay (b); in no audit event,
// API log line or stderr, and no refusal body (c, with the in-process hook
// and tracer cases in `an-inherited-hook-or-tracer-never-sees-a-models-content`);
// and the read leaves exactly one audit event for its operation id, its
// replay none (d).

import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import type { Answer } from '../api/fixture.ts';
import { rows, waitPast } from '../runtime/schedules-harness.ts';
import { leaseOf, registered, s, signedIn } from './run-stop-door-world.ts';
import {
  definitionPart,
  eventsOf,
  freshFile,
  LEASE_EXPIRY,
  leaseEndsIn,
  pinnedWork,
  read,
  readBody,
  useDefinitionWorld,
  type Pinned,
} from './definition-world.ts';
import { sendTurn, settledOnce, type Sent } from './definition-turns.ts';
import { taskPart } from './turn-world.ts';

const MARKER = `OA-DEFINITION-MARKER-${randomUUID()}`;

/** Everything written to stdout, stderr and the console while it runs. */
function capture(): { readonly text: () => string; readonly restore: () => void } {
  const spies = [
    vi.spyOn(process.stdout, 'write'),
    vi.spyOn(process.stderr, 'write'),
    ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => vi.spyOn(console, name)),
  ];
  return {
    text: () =>
      spies
        .flatMap((spy) => spy.mock.calls as unknown as unknown[][])
        .map((call) => call.map(String).join(' '))
        .join('\n'),
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

interface Flow {
  readonly on: Pinned;
  readonly path: string;
  readonly readOperation: string;
  readonly turn: Sent;
  readonly refusals: readonly Answer[];
}

/** The read, its replay, the turn, a crossing's refusal and a replay after the lease ended. */
async function plantedFlow(): Promise<Flow> {
  const path = freshFile(`# Instructions\n${MARKER}\n`);
  const on = await pinnedWork('definition marker', [path]);
  const as = await signedIn();
  const body = readBody(on, path);
  const first = await read(on, body, as);
  expect(String((first.body['detail'] as Record<string, unknown>)['text'])).toContain(MARKER);
  const replayed = await read(on, body, as);
  expect(String((replayed.body['detail'] as Record<string, unknown>)['text'])).toContain(MARKER);
  const turn = await sendTurn(on, [definitionPart(path), await taskPart(on.work)], as);
  settledOnce(turn);
  // A run that pinned the file and never read it: its turn carries the marker and is refused.
  const unread = await pinnedWork('definition marker unread', [path]);
  const { answer: crossing } = await sendTurn(
    unread,
    [definitionPart(path), await taskPart(unread.work)],
    as,
  );
  expect(crossing.body['code'], JSON.stringify(crossing.body)).toBe('PROVENANCE_UNBOUND');
  await leaseEndsIn(on.work, 1);
  await waitPast(s, LEASE_EXPIRY, leaseOf(on.work));
  const late = await read(on, body, as);
  expect(late.body['code'], JSON.stringify(late.body)).toBe('LEASE_EXPIRED');
  return { on, path, readOperation: body.operationId, turn, refusals: [crossing, late] };
}

const textsOf = async (table: 'audit_events' | 'operations'): Promise<readonly string[]> =>
  (
    await rows<{ row: string }>(
      s,
      `select to_jsonb(t)::text as row from public.${table} t where t.business_id = $1`,
      [s.business],
    )
  ).map((row) => row.row);

describe.skipIf(serverUrl === undefined)('a planted marker in an instruction file', () => {
  useDefinitionWorld('defmarker');

  it('reaches only the provider, and its read leaves one audit event', async () => {
    const output = capture();
    let flow: Flow;
    try {
      flow = await plantedFlow();
    } finally {
      output.restore();
    }
    // a. Mutation: the system message dropped from the request -> red.
    expect(JSON.stringify(flow.turn.sent)).toContain(MARKER);
    // b. Mutation: drop the row's `stored` projection -> the text in the register, red.
    const [row] = await registered(flow.readOperation);
    expect(row?.result).toMatchObject({
      detail: {
        path: flow.path,
        leaseId: leaseOf(flow.on.work),
        fence: flow.on.work.picked['fence'],
        stepId: flow.on.stepId,
        runId: flow.on.runId,
      },
    });
    expect(row?.result).not.toHaveProperty(['detail', 'text']);
    expect((await textsOf('operations')).filter((text) => text.includes(MARKER))).toEqual([]);
    // c. Mutation: log the request or answer body at the door -> red.
    expect((await textsOf('audit_events')).filter((text) => text.includes(MARKER))).toEqual([]);
    expect(output.text()).not.toContain(MARKER);
    for (const refusal of flow.refusals) expect(JSON.stringify(refusal.body)).not.toContain(MARKER);
    // d. Mutation: ignore `ownEvent` in `recordApplied` -> two events, red.
    expect(await eventsOf(flow.readOperation), 'one event for the read, none for its replay').toBe(
      1,
    );
  }, 90_000);
});
