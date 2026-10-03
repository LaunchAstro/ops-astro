// SPDX-License-Identifier: AGPL-3.0-only
//
// C71-G's group world (`c71-g-world.ts`) with the live channel mounted on a
// second app over the same database, the way `apps/api/server.ts` mounts it:
// a real LISTEN connection, the real admission, a short recheck.

import { createApi } from '../../apps/api/app.ts';
import { createSupabaseVerifier } from '../../apps/api/auth/supabase.ts';
import { startLiveTopics, type LiveTopics } from '../../apps/api/live.ts';
import {
  admitReads,
  executeAgentCommand,
  executeCommand,
  executeCredentialCommand,
  executeRead,
} from '../../packages/core-commands/src/index.ts';
import {
  connectListener,
  type BusinessId,
  type Listener,
} from '../../packages/core-records/src/index.ts';
import { ACCEPTANCE_ISSUER } from '../acceptance/cast.ts';
import { testSignIn } from '../support/sign-in.ts';
import { join, type Joined } from './c4-live-support.ts';
import { createGroupWorld, type GroupWorld } from './c71-g-world.ts';

export interface LiveGroupWorld {
  readonly g: GroupWorld;
  /** Open one tab's stream naming `topics`, as `caller`, in a business (alpha unless named). */
  open(
    caller: { readonly token: string },
    topics: readonly string[],
    key?: string,
  ): Promise<Joined>;
  /** Every payload the channel carried since the world was made, in order. */
  readonly payloads: readonly string[];
  close(): Promise<void>;
}

export const conversationTopic = (id: string): string => `conversation:${id}`;

export async function createLiveGroupWorld(part: string): Promise<LiveGroupWorld> {
  const g = await createGroupWorld(part);
  const { world } = g.chat.harness;
  const topics: LiveTopics = await startLiveTopics(connectListener(world.db.appUrl));
  const heard: Listener = connectListener(world.db.appUrl);
  const payloads: string[] = [];
  await heard.listen(
    'ops_astro_live',
    (payload) => payloads.push(payload),
    () => {},
  );
  const byKey: Readonly<Record<string, BusinessId>> = { alpha: world.alpha, bravo: world.bravo };
  const api = createApi({
    database: world.db.app,
    verify: createSupabaseVerifier(testSignIn(ACCEPTANCE_ISSUER)),
    resolveBusiness: (key: string) => Promise.resolve(byKey[key]),
    executeCommand,
    executeRead,
    executeAgentCommand,
    executeCredentialCommand,
    live: { topics, recheckMs: 200, admit: admitReads },
  });
  const opened: Joined[] = [];
  return {
    g,
    payloads,
    async open(caller, named, key = 'alpha') {
      const joined = await join(api, key, named, caller.token);
      opened.push(joined);
      return joined;
    },
    async close() {
      await Promise.all(opened.map(async (joined) => await joined.stop()));
      await topics.close();
      await heard.close();
      await g.chat.harness.close();
    },
  };
}
