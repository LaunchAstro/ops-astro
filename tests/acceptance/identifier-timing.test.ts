// SPDX-License-Identifier: AGPL-3.0-only
//
// Ledger row I04 as repeated, measured timing: for every identifier-bearing
// operation, a valid foreign identifier and a fabricated one must not be told
// apart by how long the refusal takes, as `identifier-negatives.test.ts` shows
// they cannot be told apart by status or body bytes. One sample each would say
// nothing (the L6 disposition's point about `verify-slice.mjs:102` and `:113`),
// so each operation is sent as alternating pairs after a discarded warm-up, and
// the two distributions are compared by a statistic written down below.
//
// Every sample must first be the operation's expected refusal code, so the
// comparison is between like answers and never a fast fault against a slow
// refusal. The last case is the non-vacuity check: the same comparator, fed a
// real operation with a delay injected on one arm, must flag it, which is the
// red a comparator that always said "within" could not produce.
//
// The requests go through the real HTTP application in process, against a real
// Postgres, so the time measured is the handler, the tenancy wrapper and the
// database lookups the two forms would differ in. It is not network timing.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CommandName } from '../../packages/core-records/src/commands/surface.ts';
import { COMMAND_SURFACE } from '../../packages/core-records/src/commands/surface.ts';
import { PROPOSAL } from './role-case-bodies.ts';
import { TARGET_FREE as TARGET_FREE_BODIES } from './cd-alternatives.ts';
import { serverUrl, type AgentIdentity, type Caller } from './world.ts';
import { createIdentWorld, type IdentWorld, type RawAnswer } from './ident-audit-cases.ts';

type Body = Readonly<Record<string, unknown>>;

type Presenter =
  | { readonly kind: 'person'; readonly caller: Caller }
  | { readonly kind: 'agent'; readonly identity: AgentIdentity; readonly credential?: string };

interface Cell {
  readonly op: CommandName;
  readonly operand: string;
  readonly by: Presenter;
  readonly code: string;
  readonly foreign: () => Body;
  readonly fabricated: () => Body;
}

/** Pairs sent and thrown away first: connection pools, plans and JIT settle. */
const WARM_UP_PAIRS = 5;
/** Pairs measured per operation, each arm one sample per pair. */
const PAIRS = 30;
/**
 * Two tests, and a pair of distributions is flagged only when both fail:
 *
 * - Mann-Whitney U, two-sided, normal approximation without tie correction:
 *   within while |z| <= 3.29 (p >= 0.001).
 * - Median difference: within while |median foreign - median fabricated| is at
 *   most the larger of 2 ms and 20 percent of the smaller median.
 *
 * The rank test alone is too sensitive on a loaded laptop: a steady 0.1 ms
 * drift in an in-process call is "significant" at n = 30 and says nothing a
 * caller over a network could use. The median bound alone ignores shape. A
 * real oracle, like the 15 ms delay the last case injects, fails both.
 */
const Z_LIMIT = 3.29;
const FLOOR_MS = 2;
const SHARE = 0.2;
/** The delay injected on one arm to prove the comparator can say "outside". */
const INJECTED_MS = 15;

/** The operations that name no identifier, from the list the matrix and SC2 case share. */
const TARGET_FREE: ReadonlySet<CommandName> = new Set(TARGET_FREE_BODIES.map(([op]) => op));

const NOBODY = 'text nobody should find in an audit row';

interface Verdict {
  readonly foreignMedian: number;
  readonly fabricatedMedian: number;
  readonly z: number;
  readonly difference: number;
  readonly bound: number;
  readonly within: boolean;
}

const median = (values: readonly number[]): number => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
};

/** Mann-Whitney z for `a` against `b`, ties given their average rank. */
function mannWhitneyZ(a: readonly number[], b: readonly number[]): number {
  const all = [...a.map((v) => ({ v, a: true })), ...b.map((v) => ({ v, a: false }))].toSorted(
    (x, y) => x.v - y.v,
  );
  let rankSumA = 0;
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]?.v === all[i]?.v) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) if (all[k]?.a === true) rankSumA += rank;
    i = j + 1;
  }
  const n1 = a.length;
  const n2 = b.length;
  const u = rankSumA - (n1 * (n1 + 1)) / 2;
  const sigma = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12);
  return (u - (n1 * n2) / 2) / sigma;
}

/** The recorded comparison: outside only when both the rank test and the median bound fail. */
function compare(foreign: readonly number[], fabricated: readonly number[]): Verdict {
  const foreignMedian = median(foreign);
  const fabricatedMedian = median(fabricated);
  const z = mannWhitneyZ(foreign, fabricated);
  const difference = Math.abs(foreignMedian - fabricatedMedian);
  const bound = Math.max(FLOOR_MS, SHARE * Math.min(foreignMedian, fabricatedMedian));
  const within = Math.abs(z) <= Z_LIMIT || difference <= bound;
  return { foreignMedian, fabricatedMedian, z, difference, bound, within };
}

const line = (cell: Pick<Cell, 'op' | 'operand'>, n: number, v: Verdict): string =>
  `timing ${cell.op} ${cell.operand}: n=${String(n)} ` +
  `foreign median=${v.foreignMedian.toFixed(2)}ms fabricated median=${v.fabricatedMedian.toFixed(2)}ms ` +
  `z=${v.z.toFixed(2)} diff=${v.difference.toFixed(2)}ms bound=${v.bound.toFixed(2)}ms ` +
  (v.within ? 'within' : 'OUTSIDE');

const pause = async (ms: number): Promise<void> =>
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe.skipIf(serverUrl === undefined)('identifier timing (I04)', () => {
  let w: IdentWorld;

  beforeAll(async () => {
    w = await createIdentWorld('ident_timing');
  }, 180_000);
  afterAll(async () => {
    await w?.close();
  });

  async function send(by: Presenter, op: CommandName, body: Body): Promise<RawAnswer> {
    return by.kind === 'person'
      ? await w.person(by.caller, op, body)
      : await w.agent(by.identity, op, body, by.credential);
  }

  /** One timed request, its code checked against the cell's before it counts. */
  async function timed(cell: Cell, shape: Body, delay: number): Promise<number> {
    const body = { operationId: randomUUID(), ...shape };
    const start = performance.now();
    if (delay > 0) await pause(delay);
    const answer = await send(cell.by, cell.op, body);
    const took = performance.now() - start;
    expect(answer.code, `${cell.op} ${cell.operand}: ${answer.text}`).toBe(cell.code);
    return took;
  }

  /** Warm up, then alternate the arms, flipping which goes first on each pair. */
  async function sample(
    cell: Cell,
    fabricatedDelay = 0,
  ): Promise<{ foreign: number[]; fabricated: number[] }> {
    const foreign: number[] = [];
    const fabricated: number[] = [];
    /* eslint-disable no-await-in-loop -- the samples are sequential by design */
    for (let pair = 0; pair < WARM_UP_PAIRS + PAIRS; pair += 1) {
      const keep = pair >= WARM_UP_PAIRS;
      const runForeign = async (): Promise<void> => {
        const took = await timed(cell, cell.foreign(), 0);
        if (keep) foreign.push(took);
      };
      const runFabricated = async (): Promise<void> => {
        const took = await timed(cell, cell.fabricated(), fabricatedDelay);
        if (keep) fabricated.push(took);
      };
      if (pair % 2 === 0) {
        await runForeign();
        await runFabricated();
      } else {
        await runFabricated();
        await runForeign();
      }
    }
    /* eslint-enable no-await-in-loop */
    return { foreign, fabricated };
  }

  /** The 26 cells: the 16 record-targeted operations, then the 10 with their own operand. */
  // eslint-disable-next-line max-lines-per-function -- one table, built in one place
  async function cells(): Promise<readonly Cell[]> {
    const ada: Presenter = { kind: 'person', caller: w.h.world.ada };
    const f = w.foreign;
    const onRecord: Readonly<Partial<Record<CommandName, Body>>> = {
      'task.update': { fields: { title: NOBODY } },
      'task.reopen': { reason: NOBODY },
      'task.comment': { body: NOBODY, audience: 'internal' },
      'task.propose': { ...PROPOSAL, payload: { instruction: NOBODY } },
      'task.assign': { fields: { assignee: w.h.world.mia.personId } },
      'task.triage': { fields: { intake_state: 'accepted' } },
      'task.set_stage': { fields: { stage: 'drafting' } },
      'task.set_party': { fields: { client: randomUUID() } },
      'task.set_audience': { fields: { client_visible: true } },
      'task.reparent': { parentId: null },
      'task.move': { board: null, boardSection: null },
      'task.rank': { afterId: w.h.alphaTask.id },
    };
    const targeted = COMMAND_SURFACE.filter(
      (declaration) => declaration.targetsExistingRecord || declaration.name === 'task.read',
    );
    const out: Cell[] = targeted.map((declaration) => {
      const extra = onRecord[declaration.name] ?? {};
      const revision = declaration.name === 'task.read' ? {} : { expectedRevision: 1 };
      return {
        op: declaration.name,
        operand: 'recordId',
        by: ada,
        code: 'NOT_FOUND',
        foreign: () => ({ recordId: f.task.id, ...revision, ...extra }),
        fabricated: () => ({ recordId: randomUUID(), ...revision, ...extra }),
      };
    });
    const byAda = (
      op: CommandName,
      operand: string,
      foreignId: string,
      body: (id: string) => Body,
    ) =>
      out.push({
        op,
        operand,
        by: ada,
        code: 'NOT_FOUND',
        foreign: () => body(foreignId),
        fabricated: () => body(randomUUID()),
      });
    const decision = { decision: 'approve', note: NOBODY };
    out.push({
      op: 'task.decide',
      operand: 'gateId',
      by: ada,
      code: 'NOT_FOUND',
      foreign: () => ({ gateId: f.proposal.gateId, versionId: f.proposal.versionId, ...decision }),
      fabricated: () => ({ gateId: randomUUID(), versionId: randomUUID(), ...decision }),
    });
    byAda('task.board', 'board', f.task.id, (board) => ({ board }));
    byAda('task.restore', 'batchId', f.batchId, (batchId) => ({ batchId }));
    byAda('grant.revoke', 'grantId', f.grantId, (grantId) => ({ grantId }));
    byAda('delegation.revoke', 'delegationId', f.picked.delegationId, (delegationId) => ({
      delegationId,
    }));
    const own = await w.propose('a lineage the timing cells name');
    byAda('task.cancel', 'lineageId', f.proposal.lineageId, (lineageId) => ({
      recordId: own.task.id,
      lineageId,
      reason: NOBODY,
    }));
    byAda('task.restart', 'lineageId', f.proposal.lineageId, (lineageId) => ({
      recordId: own.task.id,
      lineageId,
    }));
    out.push({
      op: 'task.pickup',
      operand: 'reservationId',
      by: { kind: 'agent', identity: w.h.world.agent },
      code: 'RESERVATION_NOT_CLAIMABLE',
      foreign: () => ({ reservationId: f.picked.reservationId }),
      fabricated: () => ({ reservationId: randomUUID() }),
    });
    const picked = await w.pickUp(w.h.world.agent, 'the timing agent’s own work');
    const agent: Presenter = {
      kind: 'agent',
      identity: w.h.world.agent,
      credential: picked.credential,
    };
    const byLease: readonly [CommandName, Body][] = [
      ['task.heartbeat', {}],
      ['task.handback', { outcome: 'completed', report: { wrote: NOBODY } }],
    ];
    for (const [op, extra] of byLease) {
      out.push({
        op,
        operand: 'leaseId',
        by: agent,
        code: 'LEASE_NOT_OWNED',
        foreign: () => ({ leaseId: f.picked.leaseId, fence: f.picked.fence, ...extra }),
        fabricated: () => ({ leaseId: randomUUID(), fence: 1, ...extra }),
      });
    }
    return out;
  }

  it('times foreign and fabricated identifiers alike on all 26 operations', async () => {
    const table = await cells();
    const names = table.map((cell) => cell.op);
    expect(new Set(names).size, 'distinct operations').toBe(26);
    expect(names).toHaveLength(26);
    const bearing = COMMAND_SURFACE.map((declaration) => declaration.name)
      .filter((name) => !TARGET_FREE.has(name))
      .toSorted();
    expect(names.toSorted(), 'every declaration outside the nine target-free ones').toStrictEqual(
      bearing,
    );
    const outside: string[] = [];
    for (const cell of table) {
      // eslint-disable-next-line no-await-in-loop -- one operation at a time, so arms share load
      const { foreign, fabricated } = await sample(cell);
      expect(foreign).toHaveLength(PAIRS);
      expect(fabricated).toHaveLength(PAIRS);
      const verdict = compare(foreign, fabricated);
      const printed = line(cell, PAIRS, verdict);
      console.log(printed);
      if (!verdict.within) outside.push(printed);
    }
    expect(outside).toStrictEqual([]);
  }, 600_000);

  it('flags an injected delay, so the comparison is not vacuous', async () => {
    // Synthetic first: the comparator on its own says within for one
    // distribution against itself and outside for the same one shifted.
    const base = Array.from({ length: PAIRS }, (_, i) => 5 + ((i * 7) % 11) / 10);
    expect(compare(base, base.toReversed()).within, 'equal').toBe(true);
    expect(
      compare(
        base,
        base.map((v) => v + INJECTED_MS),
      ).within,
      'shifted',
    ).toBe(false);

    // Then a real operation, the fabricated arm sent after a pause: the same
    // requests, the same code, and the comparator must now say OUTSIDE.
    const cell: Cell = {
      op: 'task.read',
      operand: 'recordId (fabricated arm delayed)',
      by: { kind: 'person', caller: w.h.world.ada },
      code: 'NOT_FOUND',
      foreign: () => ({ recordId: w.foreign.task.id }),
      fabricated: () => ({ recordId: randomUUID() }),
    };
    const { foreign, fabricated } = await sample(cell, INJECTED_MS);
    const verdict = compare(foreign, fabricated);
    console.log(line(cell, PAIRS, verdict));
    expect(verdict.within, `a ${String(INJECTED_MS)} ms oracle must be flagged`).toBe(false);
  }, 120_000);
});
