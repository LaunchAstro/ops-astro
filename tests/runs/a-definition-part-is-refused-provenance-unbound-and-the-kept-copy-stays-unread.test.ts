// SPDX-License-Identifier: AGPL-3.0-only
//
// #1623 R3, the definition part: the run's kept copy of a pinned file stays
// insert-only for the application (0086), so the broker never reads it back,
// and a turn that names a definition is refused `PROVENANCE_UNBOUND` at
// binding, never a server error. Proof by Sol (GPT-6.1-Sol), review of #1900 at
// 2e629a9af4, finding S1900-1; assertions unchanged.

import { describe, expect, it } from 'vitest';
import { serverUrl } from '../acceptance/world.ts';
import { liveWork } from '../runtime/schedules-harness.ts';
import { asAgent, s, signedIn, useDoorWorld } from './run-stop-door-world.ts';
import { taskPart, turnBody, turnBroker } from './turn-world.ts';

describe.skipIf(serverUrl === undefined)('a definition part', () => {
  useDoorWorld('r3definition', turnBroker(3));

  it('is refused PROVENANCE_UNBOUND, and the kept copy stays unreadable to the application', async () => {
    const work = await liveWork(s, 'r3 definition', 2000);
    const as = await signedIn();
    await expect(
      s.db.app.withBusiness(
        s.business,
        async (tx) =>
          await tx.query('select bytes from public.bootstrap_bytes where business_id = $1', [
            s.business,
          ]),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const answer = await asAgent(
      '/model/call',
      work,
      turnBody(work, 0, [
        { ref: 'definition', path: 'AGENTS.md', digest: '0'.repeat(64) },
        await taskPart(work),
      ]),
      as,
    );
    expect(answer.body['code'], JSON.stringify(answer.body)).toBe('PROVENANCE_UNBOUND');
  }, 60000);
});
