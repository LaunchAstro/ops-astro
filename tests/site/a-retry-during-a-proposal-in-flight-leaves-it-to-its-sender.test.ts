// SPDX-License-Identifier: AGPL-3.0-only
//
// A retry of a correction's proposal while its first run is still sending:
// the claim is inside its send window, so the retry reads nothing from the
// seam and settles nothing; the first run finishes, records its proposal and
// binds. A claim past the window is a lost sender's, and is reconciled by its
// seam as before.

import { describe, expect, it } from 'vitest';
import { proposalForBinding, proposeCorrection } from '../../packages/core-commands/src/index.ts';
import { approved, at, latch, serverUrl, useRegisterWorld, w } from './c80-register-world.ts';
import { BEFORE } from './c80-world.ts';
import { standIn } from './proposal-stand-in.ts';

useRegisterWorld();

describe.skipIf(serverUrl === undefined)('a retry during a proposal in flight', () => {
  it('leaves the proposal to its sender, which records it and binds', async () => {
    const id = await approved();
    const [sending, markSending] = latch();
    const [resume, release] = latch();
    const site = standIn(
      { revision: 'rev-1', blob: 'blob-base', content: BEFORE },
      {
        onSend: async (step) => {
          if (step === 'branch') {
            markSending();
            await resume;
          }
        },
      },
    );
    const first = proposeCorrection(w.world.db.app, at(id), site.ports);
    await sending;
    let retried;
    try {
      retried = await proposeCorrection(w.world.db.app, at(id), site.ports);
    } finally {
      release();
    }
    const finished = await first;
    expect(site.sent).toEqual(['branch', 'commit', 'request']);
    expect(site.requests).toHaveLength(1);
    const binding = await proposalForBinding(w.world.db.app, at(id));
    expect({ retried, finished, binding }).toMatchObject({
      retried: { kind: 'refused', code: 'PROPOSAL_IN_FLIGHT' },
      finished: { kind: 'proposed', head: 'commit-1', request: '17' },
      binding: { ok: true },
    });
  });
});
