// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-3's security line, on the mounted `/inbox/` screen over the real API
// and a real database: the screen is INB-1's read and count drawn, so what
// the read withholds is never drawn or counted. Three crossings, statuses
// checked, each with a stored canary title that must never reach the page:
// another business, another client in the same business (one grant each), and
// an agent acting under a person's live delegation, which reaches no inbox.

import { randomUUID } from 'node:crypto';
import type { ReactElement } from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { issueGrant, revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { raiseInboxItem } from '../../packages/core-records/src/index.ts';
import { DELEGATION_HEADER, pathOf } from '../../packages/core-wire/src/surface.ts';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { SCREENS } from '../../apps/web/src/screen-registry.tsx';
import { enrol, grantTo, installSpine, type Member } from '../commands/fixture.ts';
import { authorised, BUSINESS_KEY, post, tokenFor, type Answer } from '../api/fixture.ts';
import { clearingWorld, decideBody, ok } from '../commands/inbox-clearing-world.ts';
import { mount, settle } from './mount.tsx';
import { asBrowser } from '../support/sign-in.ts';

const serverUrl = databaseUrlFromEnvironment();

type Draw = (context: Record<string, unknown>) => ReactElement;

// eslint-disable-next-line max-lines-per-function -- one database world, and the cases that share it
describe.skipIf(serverUrl === undefined)('MP-7-3 the inbox screen over INB-1', () => {
  const w = clearingWorld('mp73');
  let bruno: Member;
  let brunoToken = '';

  /** What the mounted `/inbox/` screen draws for `token` in `key`: its rows, its owed figure, its words. */
  const screen = async (token: string, key = BUSINESS_KEY) => {
    const draw = (SCREENS as unknown as Readonly<Record<string, Draw | undefined>>)['agency:inbox'];
    expect(draw, 'the inbox route has a screen').toBeTypeOf('function');
    const client = new OperationsClient({
      origin: 'http://api.test',
      businessKey: key,
      signedIn: true,
      fetch: asBrowser(token, async (url, init) => await w.api.fetch(new Request(url, init))),
    });
    const view = await mount(
      (draw as Draw)({
        client,
        grantKey: `${key}:${token.slice(-8)}`,
        params: {},
        notice: null,
        storage: null,
        navigate: () => {},
      }),
    );
    // Until both reads have landed: the page shows an answer, not the loading state.
    await vi.waitFor(
      async () => {
        await settle();
        const shown = (view.find('.readstate') as HTMLElement | null)?.dataset['outcome'];
        if (shown === undefined || shown === 'loading') throw new Error('the inbox is loading');
      },
      { timeout: 10_000 },
    );
    const drawn = {
      rows: view.all('a.nt__row').map((row) => row.textContent ?? ''),
      owed: Number(view.find('.nt__sum b')?.textContent ?? 0),
      text: view.text(),
    };
    await view.unmount();
    return drawn;
  };
  const read = async (name: string, token: string, key = BUSINESS_KEY): Promise<Answer> =>
    await post(w.api, `/api/b/${key}${pathOf(name as 'inbox.read')}`, {}, authorised(token));
  const task = async (title: string, client?: string): Promise<string> => {
    const id = String(ok(await w.call('task.create', { fields: { title } })).body['recordId']);
    if (client !== undefined) {
      await w.fixture.db.admin.execute(
        `update public.records set data = data || jsonb_build_object('client', $2::text) where id = $1`,
        [id, client],
      );
    }
    return id;
  };
  const raise = async (recipient: string, subject: string, business = w.fixture.business) =>
    await w.fixture.db.app.withBusiness(
      business,
      async (tx) =>
        await raiseInboxItem(tx, {
          recipientPersonId: recipient,
          subjectRecordId: subject,
          reason: 'mention',
          fact: { kind: 'record', id: randomUUID() },
        }),
    );
  const grantRead = async (who: Member, scope: { kind: 'record' | 'party'; id: string }) =>
    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      const issued = await issueGrant(tx, [], {
        subject: { kind: 'person', id: who.personId },
        scope,
        collection: 'task',
        action: 'read',
        canDelegate: false,
        parentGrantId: null,
        grantedByActorId: w.fixture.member.actorId,
      });
      if (!issued.ok) throw new Error(`grantRead: ${issued.refusal.code}`);
      return issued.value;
    });

  beforeAll(async () => {
    await installSpine(w.fixture.db.app, w.bravo);
    bruno = await enrol(w.fixture.db.app, w.bravo, 'Bruno Inbox');
    await w.fixture.db.app.withBusiness(w.bravo, async (tx) => {
      for (const action of ['read', 'write'] as const) {
        // oxlint-disable-next-line no-await-in-loop
        await grantTo(tx, bruno, action);
      }
    });
    brunoToken = await tokenFor(bruno.presented.subject);
  }, 120_000);

  async function anotherBusiness(): Promise<void> {
    // Another business: bruno reads nothing here, and alpha's item never reaches bravo's page.
    const alphaCanary = `mp73-alpha-${randomUUID()}`;
    await raise(w.fixture.member.personId, await task(alphaCanary));
    const bravoTask = ok(
      await post(
        w.api,
        `/api/b/bravo${pathOf('task.create')}`,
        { operationId: randomUUID(), fields: { title: `mp73-bravo-${randomUUID()}` } },
        authorised(brunoToken),
      ),
    ).body;
    await raise(bruno.personId, String(bravoTask['recordId']), w.bravo);
    expect((await read('inbox.read', brunoToken)).status).not.toBe(200);
    const intruder = await screen(brunoToken);
    expect(intruder.rows).toEqual([]);
    expect(intruder.text).not.toContain(alphaCanary);
    const own = await screen(brunoToken, 'bravo');
    expect(own.rows).toHaveLength(1);
    expect(own.owed).toBe(1);
    expect(own.text).not.toContain(alphaCanary);
    expect((await screen(w.memberToken)).text).toContain(alphaCanary);
  }

  async function anotherClient(): Promise<void> {
    // Another client in the same business: a party grant on A draws A's item, never B's.
    const cora = await enrol(w.fixture.db.app, w.fixture.business, 'Cora Inbox');
    const coraToken = await tokenFor(cora.presented.subject);
    const clientA = randomUUID();
    const onA = `mp73-client-a-${randomUUID()}`;
    const onB = `mp73-client-b-${randomUUID()}`;
    await grantRead(cora, { kind: 'party', id: clientA });
    await raise(cora.personId, await task(onA, clientA));
    await raise(cora.personId, await task(onB, randomUUID()));
    const coraRead = await read('inbox.read', coraToken);
    expect(coraRead.status).toBe(200);
    const coraPage = await screen(coraToken);
    expect(coraPage.rows).toHaveLength(1);
    expect(coraPage.text).toContain(onA);
    expect(coraPage.text).not.toContain(onB);
  }

  async function underDelegation(): Promise<void> {
    // An agent under a person's live delegation reaches no inbox, on either prefix.
    const canary = `mp73-delegated-${randomUUID()}`;
    const p = await w.proposed(canary);
    const decided = ok(await w.call('task.decide', decideBody(p), w.memberToken)).body;
    const detail = (decided['detail'] as Record<string, unknown> | undefined) ?? decided;
    const agentToken = await tokenFor(w.fixture.agent.subject);
    const picked = await post(
      w.api,
      `/api/a/b/${BUSINESS_KEY}${pathOf('task.pickup')}`,
      { operationId: randomUUID(), reservationId: detail['reservationId'] },
      authorised(agentToken),
    );
    expect(picked.status, String(picked.body['code'])).toBe(200);
    const credential = String(
      ((picked.body['detail'] as Record<string, unknown> | undefined) ?? picked.body)['credential'],
    );
    const agentRead = await post(
      w.api,
      `/api/a/b/${BUSINESS_KEY}${pathOf('inbox.read')}`,
      {},
      { ...authorised(agentToken), [DELEGATION_HEADER]: credential },
    );
    expect(agentRead.status).not.toBe(200);
    expect(JSON.stringify(agentRead.body)).not.toContain(canary);
    const agentPage = await screen(agentToken);
    expect(agentPage.rows).toEqual([]);
    expect(agentPage.text).not.toContain(canary);
  }

  it('MP-7-3 isolation: another business, another client and an agent under a live delegation never see a row', async () => {
    await anotherBusiness();
    await anotherClient();
    await underDelegation();
  });

  it('MP-7-3 withheld: an item INB-1 withholds after access is lost is neither drawn nor counted', async () => {
    const dee = await enrol(w.fixture.db.app, w.fixture.business, 'Dee Inbox');
    const deeToken = await tokenFor(dee.presented.subject);
    const title = `mp73-withheld-${randomUUID()}`;
    const subject = await task(title);
    await grantRead(dee, { kind: 'record', id: await task('dee keeps this one') });
    const grant = await grantRead(dee, { kind: 'record', id: subject });
    await raise(dee.personId, subject);
    const before = await screen(deeToken);
    expect([before.rows.length, before.owed]).toEqual([1, 1]);
    expect(before.text).toContain(title);

    await w.fixture.db.app.withBusiness(w.fixture.business, async (tx) => {
      await revokeGrant(tx, grant);
    });
    const after = await screen(deeToken);
    expect([after.rows.length, after.owed]).toEqual([0, 0]);
    expect(after.text).not.toContain(title);
  });

  it('MP-7-3 count: the owed figure drawn equals inbox.count, not the rows drawn', async () => {
    await w.proposed(`mp73-count-${randomUUID()}`);
    const counted = Number(ok(await read('inbox.count', w.memberToken)).body['owed']);
    const listed = ok(await read('inbox.read', w.memberToken)).body['inbox'] as unknown[];
    const page = await screen(w.memberToken);
    expect(counted).toBeGreaterThan(0);
    expect(page.owed).toBe(counted);
    expect(page.rows).toHaveLength(listed.length);
  });
});
