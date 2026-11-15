// SPDX-License-Identifier: AGPL-3.0-only
//
// Docs isolation (#2493 piece 1, standing gate 9): another business, another client in the same
// business, and another person's agent under a live delegation, each with a canary page that never
// reaches an answer, refusals included; and a `docs:write` grant revoked while an update waits for
// the page's row covers nothing once the row is held.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { executeCommand } from '../../packages/core-commands/src/commands/envelope.ts';
import { isCommandRefusal } from '../../packages/core-commands/src/commands/refusal.ts';
import type { CommandResult } from '../../packages/core-commands/src/commands/register-store.ts';
import { revokeGrant } from '../../packages/core-records/src/authority/grants.ts';
import { mintDelegation } from '../../packages/core-records/src/authority/delegations.ts';
import { connect } from '../../packages/core-records/src/tenancy/database.ts';
import type { BusinessId } from '../../packages/core-records/src/index.ts';
import { hold, waitingOn } from '../support/lock-waits.ts';
import { grantTo, type Member } from './fixture.ts';
import { agentWorld, codeOf } from './agent-fixture.ts';
import { WHOLE, timeWorld, type TimeWorld } from './time-world.ts';

const CANARY = `canary-${randomUUID()}`;

const serverUrl = databaseUrlFromEnvironment();

if (serverUrl === undefined) {
  console.warn(
    'docs-isolation: DATABASE_URL is unset, so nothing below ran and nothing is proved.',
  );
}

let w: TimeWorld;

beforeAll(async () => {
  if (serverUrl === undefined) return;
  w = await timeWorld('dci');
  await w.db.app.withBusiness(w.alpha, async (tx) => {
    await grantTo(tx, w.ada, 'write', WHOLE, false, 'docs');
    await grantTo(tx, w.noah, 'write', WHOLE, false, 'docs');
  });
  await w.db.app.withBusiness(w.bravo, async (tx) => {
    await grantTo(tx, w.bravoOwner, 'write', WHOLE, false, 'docs');
  });
}, 180_000);

afterAll(async () => {
  await w?.db.drop();
});

const idOf = (answer: CommandResult, field: string): string => {
  if (isCommandRefusal(answer)) throw new Error(`refused ${answer.code}`);
  return String((answer.detail as Record<string, unknown>)[field]);
};

async function planted(business: BusinessId, member: Member) {
  const folderId = idOf(
    await w.as(business, member, {
      command: 'docs.create_folder',
      name: `${CANARY}-${randomUUID().slice(0, 8)}`,
    }),
    'folderId',
  );
  const pageId = idOf(
    await w.as(business, member, {
      command: 'docs.create_page',
      folderId,
      title: CANARY,
      body: `body ${CANARY}`,
    }),
    'pageId',
  );
  return { folderId, pageId };
}

async function rowsIn(business: BusinessId) {
  const [row] = await w.db.admin.execute<{
    readonly folders: number;
    readonly pages: number;
    readonly versions: number;
    readonly bodies: string;
  }>(
    `select (select count(*)::int from public.docs_folders where business_id = $1) as folders,
            (select count(*)::int from public.docs_pages where business_id = $1) as pages,
            (select count(*)::int from public.docs_page_versions where business_id = $1) as versions,
            (select coalesce(string_agg(body, '|' order by id), '') from public.docs_pages
              where business_id = $1) as bodies`,
    [business],
  );
  return row;
}

describe.skipIf(serverUrl === undefined)('docs isolation: another business', () => {
  it('another business’s folder and page are never written, filed into or named', async () => {
    const foreign = await planted(w.bravo, w.bravoOwner);
    const bravoBefore = await rowsIn(w.bravo);
    const alphaBefore = await rowsIn(w.alpha);
    for (const [body, field] of [
      [
        { command: 'docs.create_folder', name: 'under theirs', parentId: foreign.folderId },
        'parentId',
      ],
      [
        { command: 'docs.create_page', folderId: foreign.folderId, title: 'into theirs', body: '' },
        'folderId',
      ],
      [
        {
          command: 'docs.update_page',
          pageId: foreign.pageId,
          expectedVersion: 1,
          body: 'over theirs',
        },
        'pageId',
      ],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
      const answer = await w.as(w.alpha, w.ada, body);
      expect(codeOf(answer), body.command).toBe('NOT_FOUND');
      expect(isCommandRefusal(answer) ? answer.names : [], body.command).toStrictEqual([field]);
      expect(JSON.stringify(answer)).not.toContain(CANARY);
    }
    expect(await rowsIn(w.bravo)).toStrictEqual(bravoBefore);
    expect(await rowsIn(w.alpha)).toStrictEqual(alphaBefore);
    // Its name is free here: the tree is per business.
    const same = await w.as(w.alpha, w.ada, { command: 'docs.create_folder', name: CANARY });
    expect(codeOf(same)).toBe('not-a-refusal');
  });
});

describe.skipIf(serverUrl === undefined)('docs isolation: another client', () => {
  it('a docs:write grant held at one client reaches no folder or page of the business', async () => {
    const own = await planted(w.alpha, w.ada);
    await w.db.app.withBusiness(w.alpha, async (tx) => {
      await grantTo(tx, w.clientA, 'write', { kind: 'party', id: randomUUID() }, false, 'docs');
      await grantTo(tx, w.clientA, 'read', { kind: 'party', id: randomUUID() }, false, 'docs');
    });
    const before = await rowsIn(w.alpha);
    for (const body of [
      { command: 'docs.create_folder', name: 'client made' },
      { command: 'docs.create_page', folderId: own.folderId, title: 'client made', body: '' },
      { command: 'docs.update_page', pageId: own.pageId, expectedVersion: 1, body: 'client made' },
    ]) {
      // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
      const answer = await w.as(w.alpha, w.clientA, body);
      expect(codeOf(answer), body.command).toBe('SCOPE_NOT_GRANTED');
      expect(JSON.stringify(answer)).not.toContain(CANARY);
    }
    expect(await rowsIn(w.alpha)).toStrictEqual(before);
  });
});

describe.skipIf(serverUrl === undefined)(
  'docs isolation: another person’s agent under a live delegation',
  () => {
    it('an agent whose person holds docs:write, under its task delegation or a docs:write one, reaches no docs command and writes nothing', async () => {
      const world = await agentWorld('dca', `docs-agent-${randomUUID().slice(0, 8)}`);
      try {
        const decider = await world.decider('decider');
        await world.db.app.withBusiness(world.business, async (tx) => {
          await grantTo(tx, decider, 'write', WHOLE, false, 'docs');
        });
        const picked = await world.pickUp(decider, 'the agent’s task');
        const as = async (body: Record<string, unknown>) =>
          await world.asPerson(decider, { ...body, operationId: randomUUID() });
        const folderId = idOf(
          await as({ command: 'docs.create_folder', name: CANARY }),
          'folderId',
        );
        const pageId = idOf(
          await as({ command: 'docs.create_page', folderId, title: CANARY, body: CANARY }),
          'pageId',
        );
        // A delegation that carries docs:write itself, minted by the runtime as the trial mints it
        // (scoped to the agent's task: a delegation always names its purpose scope).
        const docsCredential = await world.db.app.withBusiness(world.business, async (tx) => {
          const minted = await mintDelegation(tx, {
            agentActorId: world.agentActorId,
            delegatePersonId: decider.personId,
            mintedByActorId: decider.actorId,
            purpose: `docs_${randomUUID().replaceAll('-', '')}`,
            collections: ['docs'],
            actions: ['write'],
            purposeScope: { kind: 'record', id: picked.taskId },
            expiresAt: new Date(Date.now() + 3_600_000),
          });
          if (!minted.ok) throw new Error(`docs delegation refused ${minted.refusal.code}`);
          return minted.value.credential;
        });
        const bodies = [
          { command: 'docs.create_folder', name: 'agent made' },
          { command: 'docs.create_page', folderId, title: 'agent made', body: '' },
          { command: 'docs.update_page', pageId, expectedVersion: 1, body: 'agent made' },
        ];
        for (const [credential, exact] of [
          [picked.credential, undefined],
          [docsCredential, 'DELEGATION_EXCLUDES_OPERATION'],
        ] as const) {
          for (const body of bodies) {
            // eslint-disable-next-line no-await-in-loop -- each refusal checked on its own
            const answer = await world.asAgent({ ...body, operationId: randomUUID() }, credential);
            if (exact === undefined) expect(codeOf(answer), body.command).not.toBe('not-a-refusal');
            else expect(codeOf(answer), body.command).toBe(exact);
            expect(JSON.stringify(answer)).not.toContain(CANARY);
          }
        }
        const rows = await world.db.admin.execute<{ readonly n: number }>(
          `select ((select count(*) from public.docs_folders where business_id = $1)
                 + (select count(*) from public.docs_page_versions where business_id = $1))::int as n`,
          [world.business],
        );
        expect(rows[0]?.n).toBe(2);
      } finally {
        await world.drop();
      }
    });
  },
);

/** Ada's page, and a `docs:write` grant of the task-only member's that the test revokes. */
async function pageWithALateWriter() {
  const { pageId } = await planted(w.alpha, w.ada);
  const late = await w.db.app.withBusiness(
    w.alpha,
    async (tx) => await grantTo(tx, w.taskOnly, 'write', WHOLE, false, 'docs'),
  );
  return { pageId, late };
}

/** `lockPage`'s statement, the one an update waits in. */
const LOCK_PAGE = 'from public.docs_pages where business_id = $1 and id = $2 for update';

it.skipIf(serverUrl === undefined)(
  'an update admitted before its docs:write grant was revoked during the page lock wait is refused, and writes nothing',
  async () => {
    const { pageId, late } = await pageWithALateWriter();
    const writer = connect(w.db.appUrl);
    const revoker = connect(w.db.appUrl);
    try {
      const row = await hold(w.db.appUrl, w.alpha, async (tx) => {
        await tx.query(
          'select id from public.docs_pages where business_id = $1 and id = $2 for update',
          [tx.businessId, pageId],
        );
      });
      let updating: ReturnType<typeof executeCommand> | undefined;
      try {
        updating = executeCommand(writer, w.alpha, w.taskOnly.presented, 'api', {
          command: 'docs.update_page',
          operationId: randomUUID(),
          pageId,
          expectedVersion: 1,
          body: 'after revocation',
        } as never);
        await waitingOn(w.db.admin, 'transactionid', LOCK_PAGE);
        await revoker.withBusiness(w.alpha, async (tx) => {
          expect(await revokeGrant(tx, late)).not.toBeNull();
        });
      } finally {
        await row.letGo();
      }
      const answer = await updating;
      const stored = await w.db.admin.execute<{ readonly body: string; readonly version: number }>(
        'select body, version from public.docs_pages where id = $1',
        [pageId],
      );
      expect({ answer: codeOf(answer), stored: stored[0] }).toStrictEqual({
        answer: 'SCOPE_NOT_GRANTED',
        stored: { body: `body ${CANARY}`, version: 1 },
      });
    } finally {
      await Promise.all([writer.close(), revoker.close()]);
    }
  },
);
