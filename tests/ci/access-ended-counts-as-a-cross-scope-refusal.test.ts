// SPDX-License-Identifier: AGPL-3.0-only
//
// C58 and S0-2: a person whose access was ended and who keeps calling (a
// script, say) is answered 403 `AUTH_ACCESS_ENDED`. Each such answer counts
// towards the cross-scope burst, as `AUTH_NO_MEMBERSHIP` did before the code
// was its own, so a burst of them still raises the alert.

import { expect, it } from 'vitest';
import { signalOf } from '../../apps/api/alerts/detect.ts';

it('an access-ended refusal is a cross-scope refusal for the alert counts', () => {
  const outcome = {
    business: 'alpha',
    person: 'supabase\u0000pat',
    command: 'task.board',
    items: 0,
  };
  expect(signalOf({ ...outcome, refusal: 'AUTH_ACCESS_ENDED' })).toEqual({
    kind: 'cross-scope-refusal',
    business: 'alpha',
    person: 'supabase\u0000pat',
  });
});
