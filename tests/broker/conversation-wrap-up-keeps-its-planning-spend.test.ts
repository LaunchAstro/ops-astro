// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it as vitestIt } from 'vitest';
import { writeWrapUp } from '../../packages/core-commands/src/commands/conversation-lifecycle.ts';
import { noDatabase, s, world } from './broker-world.ts';
import { ask, ownerOf, plan, setCap, usePlanningWorld } from './aw-04-planning-world.ts';

const it = noDatabase ? vitestIt.skip : vitestIt;
usePlanningWorld('x1372wrap');

it('the durable quiet-conversation wrap-up records settled planning spend', async () => {
  await setCap(s, 100_000);
  const request = await ask(s);
  world.provider.mode('answer');
  const answer = await plan(s, ownerOf(s), request);
  if (!answer.ok) throw new Error('the priced planning reply failed');
  expect(answer.actualMinor).toBeGreaterThan(0);
  await s.db.admin.execute(
    `update public.conversations set created_at = now() - interval '26 hours',
            last_activity_at = now() - interval '25 hours'
      where business_id = $1 and id = $2`,
    [s.business, request.conversation.id],
  );
  expect(
    await s.db.app.withBusiness(
      s.business,
      async (tx) =>
        await writeWrapUp(tx, {
          conversationId: request.conversation.id,
          codeRevision: 'a352fe2104b961e1ca610297ab8a268a1b9cbb7f',
        }),
    ),
  ).toMatchObject({ ok: true, written: true });
  const [wrap] = await s.db.admin.execute<{ fact: string }>(
    `select item ->> 'fact' as fact from public.conversation_wrap_ups w,
            jsonb_array_elements(w.items) item
      where w.business_id = $1 and w.conversation_id = $2 and item ->> 'key' = 'cost'`,
    [s.business, request.conversation.id],
  );
  const digits = String(answer.actualMinor).padStart(3, '0');
  expect(wrap?.fact).toBe(
    `1 priced model call, AUD ${digits.slice(0, -2)}.${digits.slice(-2)} spent`,
  );
});
