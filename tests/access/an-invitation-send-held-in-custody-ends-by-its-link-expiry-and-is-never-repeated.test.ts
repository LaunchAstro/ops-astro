// SPDX-License-Identifier: AGPL-3.0-only
//
// An invitation's send while custody has it: custody's deadline is the link's expiry when that
// comes before the in-flight fence, so a provider still answering when the link expires is cut
// there and the send records a failure, never an acceptance. A send whose custody answer never
// came back, made again, mints nothing and calls no provider: each act sends once.

import { expect, it } from 'vitest';
import { catalogue } from '../../packages/core-connectors/src/index.ts';
import { sendInvitation } from '../../packages/core-custody/src/index.ts';
import { serverUrl } from '../acceptance/world.ts';
import { TEST_EMAIL_SEND } from '../broker/email-world.ts';
import { c, countFor, invite, MAIL, received, useInvitationWorld, w } from './c39-t-world.ts';

useInvitationWorld();

/** Longer than the link has left and than the slow provider takes, so only the expiry cuts it. */
const PATIENT_MS = 20_000;

it.skipIf(serverUrl === undefined)(
  'a send custody still holds when the link expires is cut there and recorded failed',
  async () => {
    const id = await invite(c.admin);
    await w.db.admin.execute(
      "update public.invitations set expires_at = clock_timestamp() + interval '3 seconds' where id = $1",
      [id],
    );
    const patient = {
      ...w.broker,
      operations: catalogue([{ ...TEST_EMAIL_SEND, timeoutMs: PATIENT_MS }]),
    };
    w.provider.mode('slow');
    const before = received();
    const started = performance.now();
    try {
      const result = await sendInvitation(w.db.app, w.alpha, id, patient, MAIL);
      // The slow provider answers after ten seconds; the link had three.
      expect(performance.now() - started).toBeLessThan(8_000);
      expect(result).toMatchObject({ ok: false, code: 'EMAIL_FAILED', fault: 'timeout' });
    } finally {
      w.provider.mode('accept');
    }
    expect(received() - before).toBe(1);
    const states = await w.db.admin.execute<{ state: string }>(
      'select state from public.invitation_delivery_attempts where invitation_id = $1 order by observed_at',
      [id],
    );
    expect(states.map((one) => one.state)).toEqual(['asked', 'failed']);
  },
);

it.skipIf(serverUrl === undefined)(
  'a send whose custody answer was lost, made again, mints no token and calls no provider',
  async () => {
    const id = await invite(c.admin);
    const before = received();
    const lost = {
      ...w.broker,
      custody: {
        ...w.custody,
        dispatch: async (...args: Parameters<typeof w.custody.dispatch>) => {
          await w.custody.dispatch(...args);
          throw new Error('the answer from custody was lost');
        },
      },
    };
    await expect(sendInvitation(w.db.app, w.alpha, id, lost, MAIL)).rejects.toThrow(
      'the answer from custody was lost',
    );
    expect(received() - before).toBe(1);
    const again = await sendInvitation(w.db.app, w.alpha, id, w.broker, MAIL);
    expect(again).toMatchObject({ ok: false, code: 'NO_SEND_ACT' });
    expect(received() - before).toBe(1);
    expect(await countFor('enrolment_tokens', id)).toBe(1);
  },
);
