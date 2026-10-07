// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// C60: a client's written request for model use is recorded against that
// client only. Settings ▸ Access's privacy card is drawn over the real
// `access.read` answer; the first client's request is typed, the second
// client is chosen and its model use turned on, and the save goes to the real
// `client.set_privacy`. The second client's request records never hold the
// first client's requester or link, and neither client gains one. The world
// is `c60-client-privacy-world.ts`.

import { describe, expect, it } from 'vitest';
import type { AccessReadResult } from '../../packages/core-wire/src/index.ts';
import { serverUrl } from '../acceptance/world.ts';
import {
  FIRST_REQUEST,
  privacyCard,
  save,
  switchClientsMidRequest,
  type Body,
} from '../surfaces/c60-privacy-client-switch-steps.tsx';
import {
  as,
  newClient,
  requestsOf,
  setPrivacy,
  useClientsWorld,
} from './c60-client-privacy-world.ts';

useClientsWorld();

const nameOf = (result: AccessReadResult, clientId: string): string =>
  result.clientRecords.find((each) => each.clientId === clientId)?.name ?? '';

describe.skipIf(serverUrl === undefined)('C60 a written request stays with its client', () => {
  it('the card’s save after choosing another client records none of the first client’s request against the second', async () => {
    const first = await newClient('First Clinic');
    const second = await newClient('Second Clinic');
    const read = await as('/access/read', {});
    expect(read.status, 'access.read').toBe(200);
    const result = read.body as unknown as AccessReadResult;

    const saved: Body[] = [];
    const page = await privacyCard(result, (body) => saved.push(body));
    await switchClientsMidRequest(page, nameOf(result, first), nameOf(result, second));
    await save(page);
    expect(saved.map((body) => body['clientId'])).toStrictEqual([second]);
    for (const body of saved) {
      // oxlint-disable-next-line no-await-in-loop -- the one save, sent as the screen sends it
      await setPrivacy(String(body['clientId']), body);
    }

    const recorded = await requestsOf(second);
    expect(recorded.map((each) => each.requestedBy)).not.toContain(FIRST_REQUEST.requestedBy);
    expect(recorded.map((each) => each.requestLink)).not.toContain(FIRST_REQUEST.requestLink);
    expect(recorded).toHaveLength(0);
    expect(await requestsOf(first)).toHaveLength(0);
    await page.unmount();
  });
});
