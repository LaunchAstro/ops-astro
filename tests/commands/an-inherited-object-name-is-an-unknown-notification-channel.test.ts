// SPDX-License-Identifier: AGPL-3.0-only
//
// A notification channel is looked up by the caller's own text. A name every
// plain object inherits (toString, constructor, __proto__) is not a channel:
// it is refused as an unknown one, never a fault from the inherited value.

import { describe, expect, it } from 'vitest';
import { setNotificationChannel } from '../../packages/core-commands/src/commands/settings-notification.ts';
import type { CommandContext } from '../../packages/core-commands/src/commands/context.ts';
import type { TenantQuery } from '../../packages/core-records/src/index.ts';

const unused = {} as TenantQuery;
const nobody = {} as CommandContext;

describe('notification channel names', () => {
  it('an inherited object name is refused as an unknown channel, as a made-up one is', async () => {
    const answers = [];
    for (const channel of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'bogus']) {
      // eslint-disable-next-line no-await-in-loop -- one call at a time
      answers.push(await setNotificationChannel(unused, nobody, { channel, mode: 'on' }));
    }
    for (const outcome of answers) {
      expect(outcome).toMatchObject({
        refusal: { code: 'FIELD_VALUE_INVALID', names: ['channel'] },
      });
    }
  });
});
