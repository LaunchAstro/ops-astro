// SPDX-License-Identifier: AGPL-3.0-only
//
// `preference:write` for an external client user (ORCH50's ruling on the
// catalogue, CAPABILITY-SLICES.md `preference:write`): every signed-in person,
// client users with no business membership included, writes their own
// preference rows and nobody else's. R4's no-membership refusal stands for
// every other write; the two self-scoped preference writes pass it, as
// `inbox.seen` does. Each case makes a real crossing: person to person,
// another client of the business, another business.

import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { tipKey } from '../../packages/core-wire/src/tips.ts';
import { createClient } from '../../packages/core-records/src/index.ts';
import {
  insertActor,
  insertBusiness,
  insertLogin,
  insertMapping,
  insertPerson,
} from '../identity/fixture.ts';
import { grantTo, installSpine } from '../commands/fixture.ts';
import { tokenFor } from './fixture.ts';
import {
  ada,
  adaToken,
  call,
  dismiss,
  dismissedOf,
  expectNoCanary,
  fixture,
  rowsOf,
  save,
  usePreferencesWorld,
} from './preferences-world.ts';

const serverUrl = databaseUrlFromEnvironment();

const TIP = { page: 'client:shared-task', tip: 'shared-comments' } as const;
const OTHER = { page: 'client:shared-task', tip: 'shared-files' } as const;

interface ClientUser {
  readonly personId: string;
  readonly actorId: string;
  readonly token: string;
}

/** A person of one client: a login and a read share on that client, no membership (R4). */
async function clientUser(businessId: string, name: string): Promise<ClientUser> {
  const made = await fixture.db.app.withBusiness(businessId, async (tx) => {
    const personId = await insertPerson(tx, name);
    const actorId = await insertActor(tx, personId);
    const subject = `client-user-${randomUUID()}`;
    await insertMapping(tx, await insertLogin(tx, subject), personId, actorId);
    const client = await createClient(tx, `Client ${randomUUID()}`, actorId);
    if (!client.ok) throw new Error('client not made');
    const person = { personId, actorId, presented: { provider: 'supabase', subject } } as const;
    await grantTo(tx, person, 'read', { kind: 'party', id: client.value });
    return { personId, actorId, subject };
  });
  return { personId: made.personId, actorId: made.actorId, token: await tokenFor(made.subject) };
}

describe.skipIf(serverUrl === undefined)('preference:write for a client user', () => {
  usePreferencesWorld('prefcu');
  ownRows();
  personToPerson();
  realCrossings();
});

function ownRows(): void {
  it('preference:write for a client user: with no membership they dismiss their own tip and save their own appearance', async () => {
    const cleo = await clientUser(fixture.business, 'Cleo Client');
    const dismissed = await dismiss({ ...TIP, version: 1 }, cleo.token);
    expect(dismissed.status, JSON.stringify(dismissed.body)).toBe(200);
    const saved = await save('appearance', 'dark', cleo.token);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const seen = await call('preference.read', {}, cleo.token);
    expect(seen.status).toBe(200);
    expect(seen.body['preferences']).toStrictEqual({
      appearance: 'dark',
      'tips.dismissed': { [tipKey(TIP.page, TIP.tip)]: 1 },
    });
    expectNoCanary(seen);
  });
}

function personToPerson(): void {
  it('preference:write for a client user, person to person: naming another person writes nothing of theirs', async () => {
    expect((await dismiss({ ...OTHER, version: 2 }, adaToken)).status).toBe(200);
    const cleo = await clientUser(fixture.business, 'Cleo Aims');
    const adaRows = await rowsOf(ada.personId);
    for (const [aim, status, code] of [
      ['personId', 422, 'FIELD_NOT_WRITABLE'],
      ['person', 400, 'COMMAND_BODY_INVALID'],
      ['recipientPersonId', 400, 'COMMAND_BODY_INVALID'],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const aimed = await dismiss({ ...TIP, version: 3, [aim]: ada.personId }, cleo.token);
      expect(aimed.status, aim).toBe(status);
      expect(aimed.body['code'], aim).toBe(code);
      expectNoCanary(aimed);
    }
    expect(await rowsOf(ada.personId)).toStrictEqual(adaRows);
    expect(await rowsOf(cleo.personId)).toStrictEqual([]);
    expect(await dismissedOf(adaToken)).toStrictEqual({ [tipKey(OTHER.page, OTHER.tip)]: 2 });
  });
}

function realCrossings(): void {
  it('preference:write for a client user, real crossings: another client user and another business are never reached', async () => {
    const cleo = await clientUser(fixture.business, 'Cleo Client A');
    const cy = await clientUser(fixture.business, 'Cy Client B');
    expect((await dismiss({ ...TIP, version: 4 }, cleo.token)).status).toBe(200);
    expect((await dismiss({ ...OTHER, version: 5 }, cy.token)).status).toBe(200);
    expect(await dismissedOf(cleo.token)).toStrictEqual({ [tipKey(TIP.page, TIP.tip)]: 4 });
    expect(await dismissedOf(cy.token)).toStrictEqual({ [tipKey(OTHER.page, OTHER.tip)]: 5 });

    // Another business: a client user of bravo is refused at alpha's address,
    // and alpha's client user at bravo's; nothing is written either side.
    const bravo = await insertBusiness(fixture.db.app, 'bravo');
    await installSpine(fixture.db.app, bravo);
    const bo = await clientUser(bravo, 'Bo Client');
    const cleoRows = await rowsOf(cleo.personId);
    for (const [token, key] of [
      [bo.token, undefined],
      [cleo.token, 'bravo'],
    ] as const) {
      // oxlint-disable-next-line no-await-in-loop
      const across = await dismiss({ ...TIP, version: 6 }, token, key === undefined ? {} : { key });
      expect(across.status, JSON.stringify(across.body)).toBe(403);
      expectNoCanary(across);
      // oxlint-disable-next-line no-await-in-loop
      const looked = await call('preference.read', {}, token, key === undefined ? {} : { key });
      expect(looked.status).toBe(403);
      expectNoCanary(looked);
    }
    expect(await rowsOf(bo.personId)).toStrictEqual([]);
    expect(await rowsOf(cleo.personId)).toStrictEqual(cleoRows);
    expect((await dismiss({ ...TIP, version: 7 }, bo.token, { key: 'bravo' })).status).toBe(200);
    expect(await dismissedOf(cy.token)).toStrictEqual({ [tipKey(OTHER.page, OTHER.tip)]: 5 });
  });
}
