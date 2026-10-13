// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import type { Admit } from '../../packages/core-custody/src/custody.ts';
import { connect, heldScopes } from '../../packages/core-records/src/index.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { pricedWorld } from './priced-chat-world.ts';

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  'Sol proof, criterion 1: a paid page send holds its task read grant until custody receives it',
  async () => {
    const p = await pricedWorld('sol_1567_page_grant');
    const observer = connect(p.w.fixture.db.appUrl);
    try {
      const { db, business } = p.w.fixture;
      const made = await p.w.as(p.w.owner, 'task.create', {
        fields: { title: 'Private internal roster' },
      });
      expect(made.status).toBe(200);
      const taskId = String(made.body['recordId']);
      const asked = await p.question('What is left?', undefined, {
        scope: { kind: 'task', id: taskId },
      });
      let revokedBeforeCustody = false;
      const exchange = await p.twin((broker) => {
        const custody = broker.custody;
        return {
          ...broker,
          custody: {
            ...custody,
            dispatch: async (ref, request, onPiece, admit) => {
              const gated: Admit = async () => {
                const admission = await admit?.();
                expect(admission).toBeDefined();
                // At this point the send is admitted, but custody has received no request.
                expect(p.openrouter.received).toHaveLength(0);
                try {
                  const changed = await db.admin.transaction(async (execute) => {
                    await execute("set local lock_timeout = '1s'");
                    return await execute<{ id: string }>(
                      `update public.grants set revoked_at = clock_timestamp()
                        where business_id = $1 and collection = 'task' and action = 'read'
                          and subject_id in ($2, $3) and revoked_at is null returning id`,
                      [business, p.w.owner.personId, p.w.owner.actorId],
                    );
                  });
                  expect(changed.length).toBeGreaterThan(0);
                  revokedBeforeCustody = true;
                  expect(
                    await observer.withBusiness(business, (tx) =>
                      heldScopes(
                        tx,
                        [
                          { kind: 'person', id: p.w.owner.personId },
                          { kind: 'actor', id: p.w.owner.actorId },
                        ],
                        { collection: 'task', action: 'read' },
                      ),
                    ),
                  ).toHaveLength(0);
                } catch (cause) {
                  if ((cause as { code?: string }).code !== '55P03') throw cause;
                }
                return admission;
              };
              return await custody.dispatch(ref, request, onPiece, gated);
            },
          },
        };
      });
      await exchange(db.app, business, p.w.owner.presented, asked);
      expect(p.openrouter.received).toHaveLength(1);
      const fields = p.openrouter.received[0]?.body['fields'] as Record<string, string>;
      expect(fields['page']).toContain('Private internal roster');
      expect(
        revokedBeforeCustody,
        'The task read revocation committed before custody received the page prompt',
      ).toBe(false);
    } finally {
      await observer.close();
      await p.stop();
    }
  },
  180_000,
);
