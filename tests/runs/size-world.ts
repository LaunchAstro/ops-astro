// SPDX-License-Identifier: AGPL-3.0-only
//
// What the #2091 size proofs share: the door world's turn broker with a
// replay adapter that declares a body limit the case sets, so a turn's
// request can be sized against it at the hold and again at the send, and the
// bytes each build gave.

import type { ModelBroker } from '../../packages/core-commands/src/index.ts';
import {
  catalogue,
  REPLAY_COMPOSE,
  replayAdapter,
  replayCostMinor,
  REPLAY_TURN,
  type AdapterRequest,
} from '../../packages/core-connectors/src/index.ts';
import { CLOUD, LOCAL } from '../broker/broker-world.ts';
import { s, world } from './run-stop-door-world.ts';

export interface Sizing {
  /** The body limit the adapter declares now. */
  limit: number;
  /** Bytes each build gave, in order; a build with a call id is the send's. */
  readonly built: { readonly bytes: number; readonly atSend: boolean }[];
  /** How the send's build differs from the hold's: none, or padded past any limit. */
  grow: number;
}

export const sizing: Sizing = { limit: Number.MAX_SAFE_INTEGER, built: [], grow: 0 };

/** Replay's request, never naming the call, so the hold and the send size the same bytes. */
function build(values: Readonly<Record<string, string>>, callId?: string): AdapterRequest {
  const request = replayAdapter(values);
  const body = callId === undefined ? request.body : request.body + ' '.repeat(sizing.grow);
  sizing.built.push({ bytes: Buffer.byteLength(body), atSend: callId !== undefined });
  return { ...request, body };
}

export const sizedBroker = (): ModelBroker =>
  ({
    custody: world.custody,
    operations: catalogue([REPLAY_COMPOSE, REPLAY_TURN]),
    providers: new Map([
      [
        'replay',
        {
          build,
          price: replayCostMinor,
          get bodyLimit() {
            return sizing.limit;
          },
        },
      ],
    ]),
    routes: [CLOUD, LOCAL],
    installation: 'here',
    callLimit: 10,
  }) as ModelBroker;

/** The call rows on a lease and the prompt copies registered for them. */
export async function callsAndCopies(lease: string): Promise<{
  readonly states: readonly string[];
  readonly copies: number;
}> {
  const calls = await s.db.admin.execute<{ id: string; state: string }>(
    `select id::text, state from public.model_calls where business_id = $1 and lease_id = $2`,
    [s.business, lease],
  );
  const keys = calls.map((call) => `model_call:${call.id}`);
  const [copies] = await s.db.admin.execute<{ n: number }>(
    `select count(*)::int as n from public.copy_registrations
      where business_id = $1 and copy_key = any($2::text[])`,
    [s.business, keys],
  );
  return { states: calls.map((call) => call.state), copies: copies?.n ?? 0 };
}
