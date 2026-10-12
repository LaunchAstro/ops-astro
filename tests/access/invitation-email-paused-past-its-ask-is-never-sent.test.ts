// SPDX-License-Identifier: AGPL-3.0-only
//
// An invitation's email holds a place under `email.send`'s one ceiling, as an
// inbox email does, until custody's timeout and a grace have passed since its
// `asked`. A send that waited on its way out past that bound, after its own
// fence passed it, would go out beside the email that took its place. Custody
// is told when the place ends, so such a send is never made, and the attempt
// records the refusal.

import { expect, it } from 'vitest';
import { IN_FLIGHT_GRACE_MS } from '../../packages/core-custody/src/email-class.ts';
import { TEST_EMAIL_SEND } from '../broker/email-world.ts';
import { custodyAhead } from '../broker/custody-clock-ahead.ts';
import { c, invite, noDatabase, received, send, useInvitationWorld, w } from './c39-t-world.ts';

useInvitationWorld();

it.skipIf(noDatabase)(
  'an invitation email that reaches custody after its place under the ceiling has ended is never sent',
  async () => {
    w.provider.mode('accept');
    const id = await invite(c.admin);
    const before = received();
    const result = await custodyAhead(
      TEST_EMAIL_SEND.timeoutMs + IN_FLIGHT_GRACE_MS,
      async () => await send(id),
    );
    const attempts = await w.db.admin.execute<{ state: string; evidence: string | null }>(
      `select state, evidence from public.invitation_delivery_attempts
        where invitation_id = $1 order by observed_seq`,
      [id],
    );
    expect({ result, attempts, sent: received() - before }).toMatchObject({
      result: { ok: false, code: 'EMAIL_FAILED', fault: 'refused' },
      attempts: [
        { state: 'asked', evidence: null },
        { state: 'failed', evidence: 'refused' },
      ],
      sent: 0,
    });
  },
);
