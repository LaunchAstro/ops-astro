// SPDX-License-Identifier: AGPL-3.0-only
//
// The world C71-D's suites share: the role-case harness (alpha and bravo, a
// client pair in each, an agent), with `chat:comment` granted to the staff who
// talk. In alpha, Ada (admin) and Mia talk and Tess, staff holding the same
// key, is the third person. In bravo, Bea and Bo talk.

// Sequential on purpose: grants share one transaction, tables are read one by one.
// oxlint-disable no-await-in-loop
import { createHarness, type Harness } from '../acceptance/role-case-harness.ts';
import { enrolCaller, type Caller } from '../acceptance/cast.ts';
import type { Answer } from '../acceptance/world.ts';
import { grantTo, type Member } from '../commands/fixture.ts';

export interface ChatWorld {
  readonly harness: Harness;
  readonly tess: Caller;
  readonly bo: Caller;
  /** `chat.send_direct` from a caller to a teammate. */
  send(from: Caller, to: Caller | string, body: string, business?: string): Promise<Answer>;
  /** A read or a write as a caller, in a business. */
  as(
    caller: { readonly token: string },
    name: Parameters<Harness['asPerson']>[0],
    body?: Readonly<Record<string, unknown>>,
    business?: string,
  ): Promise<Answer>;
  /** Every row of every table holding this text, as `table` once per row, past row security. */
  holding(text: string): Promise<readonly string[]>;
  /** A delegated agent's credential, live (`task.pickup`). */
  agentCredential(): Promise<string>;
}

const CHAT = { membership: true, actions: ['comment'], collections: ['chat'] } as const;

// eslint-disable-next-line max-lines-per-function -- one world, built in one place
export async function createChatWorld(part: string): Promise<ChatWorld> {
  const harness = await createHarness(part);
  const { world } = harness;
  const tess = await enrolCaller(world.db, world.alpha, 'alpha', 'tess', CHAT);
  const bo = await enrolCaller(world.db, world.bravo, 'bravo', 'bo', CHAT);
  for (const [business, who] of [
    [world.alpha, world.mia],
    [world.bravo, world.bea],
  ] as const) {
    await world.db.app.withBusiness(business, async (tx) => {
      await grantTo(tx, who as unknown as Member, 'comment', undefined, false, 'chat');
    });
  }
  const as: ChatWorld['as'] = async (caller, name, body = {}, business = 'alpha') =>
    await harness.asPerson(name, body, business, caller);
  return {
    harness,
    tess,
    bo,
    as,
    send: async (from, to, body, business = from.businessKey) =>
      await as(
        from,
        'chat.send_direct',
        { teammateId: typeof to === 'string' ? to : to.personId, body },
        business,
      ),
    async holding(text) {
      const tables = await world.db.admin.execute<{ readonly name: string }>(
        `select format('%I.%I', n.nspname, c.relname) as name
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname in ('public', 'ops') and c.relkind in ('r', 'p') order by 1`,
      );
      const found: string[] = [];
      for (const { name } of tables) {
        const rows = await world.db.admin.execute<{ readonly n: string }>(
          `select count(*)::text as n from ${name} t where strpos(t::text, $1) > 0`,
          [text],
        );
        for (let n = 0; n < Number(rows[0]?.n); n += 1) found.push(name);
      }
      return found;
    },
    async agentCredential() {
      const { decided } = await harness.approvedReservation();
      const detail = decided.body['detail'] as Readonly<Record<string, unknown>>;
      const picked = await harness.asAgent('task.pickup', {
        reservationId: String(detail['reservationId']),
      });
      return String((picked.body['detail'] as Readonly<Record<string, unknown>>)['credential']);
    },
  };
}
