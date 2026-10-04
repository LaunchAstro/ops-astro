// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { catalogue, EMAIL_SEND, emailAdapter } from '../../packages/core-connectors/src/index.ts';
import { sendInboxEmail, type Broker } from '../../packages/core-custody/src/index.ts';
import { connect, type Database } from '../../packages/core-records/src/index.ts';
import { createGroupWorld, detailOf } from './c71-g-world.ts';

function latch() {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release?.() };
}

function mailProbe(): { broker: Broker; dispatched: string[] } {
  const dispatched: string[] = [];
  return {
    dispatched,
    broker: {
      custody: {
        pid: 0,
        dispatch: (ref) => {
          dispatched.push(ref);
          return Promise.resolve({ kind: 'refused', started: false, code: 'NOT_SENT_IN_TEST' });
        },
        stderr: () => '',
        raw: () => Promise.resolve({}),
        kill: () => {},
        stop: () => Promise.resolve(),
      },
      operations: catalogue([EMAIL_SEND]),
      providers: new Map([['resend', { build: emailAdapter, price: () => 0 }]]),
      routes: [
        {
          key: 'email',
          reach: 'cloud',
          provider: 'resend',
          credentialRef: 'test_key',
          credentialKind: 'api_key',
          installation: 'here',
          ceiling: 4,
        },
      ],
      installation: 'here',
      audit: () => Promise.resolve(),
    },
  };
}

// eslint-disable-next-line max-lines-per-function -- one controlled interleaving and its cleanup
it('a mention email under way when the recipient loses business access is not dispatched', async () => {
  const g = await createGroupWorld('c71mailend');
  const { world } = g.chat.harness;
  const reader = connect(world.db.appUrl);
  const reached = latch();
  const resume = latch();
  const paused: Database = {
    log: reader.log,
    close: () => reader.close(),
    withBusiness: (business, run) =>
      reader.withBusiness(business, (tx) =>
        run({
          ...tx,
          async query<Row>(
            statement: string,
            parameters?: readonly unknown[],
          ): Promise<readonly Row[]> {
            if (statement.includes('select value from public.person_identifiers')) {
              reached.release();
              await resume.promise;
            }
            return await tx.query<Row>(statement, parameters);
          },
        }),
      ),
  };
  let sending: ReturnType<typeof sendInboxEmail> | undefined;
  try {
    const sent = await g.as(g.chat.tess, 'chat.send_group', {
      conversationId: g.conversationId,
      body: '@Mia before access ends',
      mentions: [world.mia.personId],
    });
    expect(sent.status, sent.text).toBe(200);
    const [item] = await world.db.admin.execute<{ id: string }>(
      'select id from public.inbox_items where business_id = $1 and fact_id = $2 and recipient_person_id = $3',
      [world.alpha, detailOf(sent)['commentId'], world.mia.personId],
    );
    if (item === undefined) throw new Error('mention item missing');
    await world.db.admin.execute(
      `insert into public.person_identifiers
        (business_id, id, person_id, kind, value, observed_value, source_system, review_state)
       values ($1, gen_random_uuid(), $2, 'email', $3, $3, 'test', 'confirmed')`,
      [world.alpha, world.mia.personId, 'synthetic-ended-mia@example.test'],
    );
    const { broker, dispatched } = mailProbe();
    const mail = { appOrigin: 'https://ops.example.test', from: 'hello@example.test' };
    sending = sendInboxEmail(paused, world.alpha, item.id, broker, mail);
    await reached.promise;
    const ended = await g.as(world.ada, 'access.end', { holderId: world.mia.personId });
    expect(ended.status, ended.text).toBe(200);
    expect(
      (await g.as(world.mia, 'chat.messages', { conversationId: g.conversationId })).code,
    ).toBe('AUTH_NO_MEMBERSHIP');
    resume.release();
    expect.soft(await sending).toEqual({ ok: false, code: 'ITEM_WITHHELD' });
    expect.soft(dispatched).toEqual([]);
    expect(await sendInboxEmail(world.db.app, world.alpha, item.id, broker, mail)).toEqual({
      ok: false,
      code: 'ITEM_WITHHELD',
    });
  } finally {
    resume.release();
    await sending;
    await reader.close();
    await g.chat.harness.close();
  }
}, 180_000);
