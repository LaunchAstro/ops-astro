// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// Client privacy saved on, then off, both answers lost after the server stored
// them, then on again: the last is a new intent. Under the first save's held
// id the server only replays that save's stored answer and keeps the second's
// "off", while the screen says the settings were saved.

import { afterEach, expect, it } from 'vitest';
import { AccessScreen } from '../../apps/web/src/screens/Access.tsx';
import { raceServer, stored } from '../web/write-race-support.tsx';
import { mount, settle, type Mounted } from './mount.tsx';
import { ACME, ADA, MIA, access, choose } from './access-screen-world.tsx';

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

const HEALTH = '[data-privacy-setting="health"] button[role="switch"]';
const SAVE = '[data-access="client-privacy"] button[type="submit"]';

it('privacy set back to an earlier choice after two lost answers is saved, not replayed', async () => {
  const record = { health: false };
  const api = raceServer((path, body) => {
    if (path === '/access/read') return { status: 200, body: access([ADA, MIA]) };
    record.health = body['handlesHealth'] === true;
    return stored(1);
  });
  view = await mount(<AccessScreen client={api.client} grantKey="alpha:ada:0" />);
  await settle();
  await settle();
  await choose(view, 'privacy-client', ACME.name);
  api.fates.push('lose', 'lose');
  for (const health of [true, false, true]) {
    // eslint-disable-next-line no-await-in-loop -- one save after another, as a person makes them
    await view.click(HEALTH);
    // eslint-disable-next-line no-await-in-loop -- as above
    await view.click(SAVE);
    // eslint-disable-next-line no-await-in-loop -- as above
    await settle();
    expect(api.sent.at(-1)?.body['handlesHealth']).toBe(health);
  }
  expect(view.find('[data-access-outcome]')?.textContent).toContain('Saved');
  expect(record.health, 'the last save asked for health information on').toBe(true);
});
