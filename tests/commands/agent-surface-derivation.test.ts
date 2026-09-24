// SPDX-License-Identifier: AGPL-3.0-only
//
// What an agent reaches is read off the surface rows' `agent` field
// (`agent-envelope.ts`, SWEEP-2 item 9), and how each is served is a row of
// `AGENT_OPERATIONS`. The two tables say one list: every reachable operation
// has a row to serve it and no row serves an operation the surface keeps from
// an agent, and the pre-pickup pair is the rows that authorise before a
// pickup. `command-catalogue-pin.test.ts` pins the lists themselves.

import { describe, expect, it } from 'vitest';
import {
  AGENT_SURFACE,
  BEFORE_PICKUP,
} from '../../packages/core-records/src/commands/agent-envelope.ts';
import { AGENT_OPERATIONS } from '../../packages/core-records/src/commands/agent-operations.ts';

describe('the agent surface and the agent operation table', () => {
  it('reach the same operations', () => {
    expect([...AGENT_OPERATIONS.keys()].toSorted()).toStrictEqual([...AGENT_SURFACE].toSorted());
  });

  it('agree on the two an agent reaches before a pickup', () => {
    const beforePickup = [...AGENT_OPERATIONS]
      .filter(([, row]) => row.authority === 'beforePickup')
      .map(([name]) => name);
    expect(beforePickup.toSorted()).toStrictEqual([...BEFORE_PICKUP].toSorted());
  });
});
