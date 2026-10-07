// SPDX-License-Identifier: AGPL-3.0-only
//
// A group's entry in `chat.conversations` carries when the reader joined it,
// from their own member row and never another member's, so a screen can see a
// rejoin it missed: a later join reads later, a departed reader reads null.

import { expect, it } from 'vitest';
import type { Caller } from '../acceptance/cast.ts';
import { databaseUrlFromEnvironment } from '../support/fresh-database.ts';
import { createGroupWorld } from './c71-g-world.ts';

it.skipIf(databaseUrlFromEnvironment() === undefined)(
  "a group's view carries the reader's own join time, null once they leave and later after a rejoin",
  async () => {
    const g = await createGroupWorld('readerjoin');
    const { chat, zed, conversationId, as, viewOf } = g;
    const { world } = chat.harness;
    const joined = async (who: Caller): Promise<string | undefined> =>
      (
        await world.db.admin.execute<{ readonly at: string }>(
          `select to_char(joined_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as at
             from public.team_conversation_members where conversation_id = $1 and person_id = $2`,
          [conversationId, who.personId],
        )
      )[0]?.at;
    const change = async (body: Readonly<Record<string, unknown>>): Promise<void> => {
      const answer = await as(chat.tess, 'chat.change_members', { conversationId, ...body });
      expect(answer.status, answer.text).toBe(200);
    };
    const joinOf = async (who: Caller): Promise<string | null | undefined> =>
      (await viewOf(who))?.joinedAt;
    try {
      const first = await joined(world.mia);
      expect(await joinOf(world.mia)).toBe(first);
      await change({ add: [zed.personId] });
      // Each reader sees their own row: Zed's later join, Mia's unchanged.
      expect(await joinOf(zed)).toBe(await joined(zed));
      expect(await joinOf(zed)).not.toBe(first);
      expect(await joinOf(world.mia)).toBe(first);
      await change({ remove: [world.mia.personId] });
      expect(await joinOf(world.mia)).toBeNull();
      await change({ add: [world.mia.personId] });
      const again = await joinOf(world.mia);
      expect(again).toBe(await joined(world.mia));
      expect(Date.parse(String(again))).toBeGreaterThan(Date.parse(String(first)));
    } finally {
      await chat.harness.close();
    }
  },
  180_000,
);
