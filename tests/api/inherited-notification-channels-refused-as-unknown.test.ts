// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createControls, type Controls } from './controls-fixture.ts';

const serverUrl = databaseUrlFromEnvironment();

let controls: Controls | undefined;
beforeAll(async () => {
  if (serverUrl === undefined) return;
  controls = await createControls('sol1376_channel');
}, 180_000);
afterAll(async () => await controls?.drop());

it.skipIf(serverUrl === undefined)(
  'inherited notification channels are refused as unknown channels',
  async () => {
    if (controls === undefined) throw new Error('Expected the API fixture');
    const ordinary = await controls.asPerson('notifications.set_channel', {
      channel: 'sms',
      mode: 'on',
    });
    expect(ordinary.status).toBe(422);
    expect(ordinary.body).toMatchObject({ code: 'FIELD_VALUE_INVALID', names: ['channel'] });
    for (const channel of ['__proto__', 'toString', 'constructor', 'hasOwnProperty']) {
      // eslint-disable-next-line no-await-in-loop -- one command at a time, each checked by name
      const answer = await controls.asPerson('notifications.set_channel', { channel, mode: 'on' });
      expect(answer.status, channel).toBe(422);
      expect(answer.body, channel).toMatchObject({
        code: 'FIELD_VALUE_INVALID',
        names: ['channel'],
      });
    }
  },
);
