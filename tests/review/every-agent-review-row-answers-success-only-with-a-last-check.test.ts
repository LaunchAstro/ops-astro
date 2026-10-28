// SPDX-License-Identifier: AGPL-3.0-only
//
// Sol's round 2 on #2276: the agent path waits on its identity locks after a review handler
// returns (`agent-standing.ts`), and anything the handler judged (a lease, a grant, a
// delegation, the clock) can lapse in that wait. So every success an agent review row can
// answer carries its `lastCheck`. The rows are walked here: a row that serves is typed to
// return `JudgedLast`, which a success without a last check does not satisfy, so
// `pnpm run typecheck` fails on any such path; a row that serves nothing answers no success.
// The review commands an agent reaches are exactly these rows: a decision has none.

import { describe, expect, expectTypeOf, it } from 'vitest';
import { reviewAgentRows } from '../../packages/core-commands/src/commands/review-agent.ts';
import { AGENT_OPERATIONS } from '../../packages/core-commands/src/commands/agent-operations.ts';
import type { Applied, JudgedLast } from '../../packages/core-commands/src/commands/outcome.ts';

type Row = Parameters<Parameters<typeof reviewAgentRows>[0]>[0];
type Serving = Extract<Row, { readonly serve: unknown }>;
type Answered = Awaited<ReturnType<Serving['serve']>>;

const rows = reviewAgentRows((typed) => typed);

describe('the agent review rows and their last check', () => {
  it('every success a serving row can answer carries a last check', () => {
    expectTypeOf<Answered>().toExtend<JudgedLast>();
    // The check has teeth: an applied answer without its last check is not one.
    expectTypeOf<Applied>().not.toExtend<JudgedLast>();
  });

  it('a row that serves nothing is a business row, refused outside every pickup', () => {
    const silent = rows.filter(([, row]) => !('serve' in row));
    expect(silent.map(([name, row]) => [name, row.authority])).toStrictEqual([
      ['review.open', 'business'],
      ['review.capture', 'business'],
    ]);
  });

  it('the review commands an agent reaches are these rows alone', () => {
    const reached = [...AGENT_OPERATIONS.keys()].filter((name) => name.startsWith('review.'));
    expect(reached.toSorted()).toStrictEqual(rows.map(([name]) => name).toSorted());
    expect(reached).not.toContain('review.decide');
    expect(reached).not.toContain('review.decide_change');
    expect(reached).not.toContain('review.record_astra_review');
  });
});
