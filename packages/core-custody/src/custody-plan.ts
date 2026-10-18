// SPDX-License-Identifier: AGPL-3.0-only
//
// The owner's ChatGPT plan inside custody's process (#1620 P4). Custody reads
// the plan's token file and issuer from its own environment and builds the
// holder through the production holder only (#1704), so only on the plan's
// own issuer. `prepare` makes the token ready and answers a word, never the
// token. A dispatch to the plan presents the token at once, with no file, lock
// or refresh, or is refused `SUBSCRIPTION_REFRESH_FAILED` with nothing sent.
// It goes through egress with the token as a bearer, so nothing is filed in
// the credential file. The stream is read whole, no piece passed on, and
// judged once (`askPlanOnce`) against the holder's secrets: the completed
// response, or a named refusal.

import { isAbsolute } from 'node:path';
import { PLAN_PROVIDER } from './carry-rule.ts';
import { send, type Destination, type OutboundRequest, type SendGate } from './egress.ts';
import { askPlanOnce } from './plan-answer.ts';
import type { TokenHolder } from './plan-token.ts';

/** The plan issuer's token path (#1634), as the owner's sign-in uses it. */
const TOKEN_PATH = '/api/accounts/oauth/token';

/** The plan route's one destination. */
export const PLAN_DESTINATION: string = PLAN_PROVIDER;

type Reply = Record<string, unknown>;

/**
 * The plan's holder from custody's environment: none when neither setting is
 * there; `refused` when one is missing, the file is not an absolute path, or
 * the issuer is not the plan's.
 */
export async function planHolderOf(
  env: NodeJS.ProcessEnv,
): Promise<TokenHolder | undefined | 'refused'> {
  const file = env['CUSTODY_PLAN_TOKEN_FILE'];
  const issuer = env['CUSTODY_PLAN_ISSUER'];
  if (file === undefined && issuer === undefined) return undefined;
  const tokenUrl = URL.parse(TOKEN_PATH, issuer ?? '');
  if (file === undefined || !isAbsolute(file) || tokenUrl === null) return 'refused';
  // Loaded only by a custody that holds the plan: its token store is on node:sqlite.
  const { productionTokenHolder } = await import('./plan-token-production.ts');
  const built = productionTokenHolder({ file, tokenUrl });
  return built.ok ? built.holder : 'refused';
}

/** Custody's answer to `prepare`: the word, with the holder's code when it refuses. */
export async function prepared(holder: TokenHolder | undefined): Promise<Reply> {
  if (holder === undefined) return { type: 'refused', code: 'CUSTODY_UNKNOWN_REQUEST' };
  const out = await holder.prepare();
  return out.ok ? { type: 'prepared' } : { type: 'refused', code: out.code };
}

/** One plan dispatch, sent at most once: the folded answer, or a named refusal. */
export async function planDispatch(
  holder: TokenHolder,
  destinations: ReadonlyMap<string, Destination>,
  request: OutboundRequest,
  gate: SendGate | undefined,
): Promise<Reply> {
  const token = holder.present();
  if (!token.ok) return { type: 'refused', code: token.code };
  const bearer = { header: 'authorization', scheme: 'bearer', value: token.accessToken } as const;
  let lapsed = false;
  const result = await askPlanOnce(
    async () => {
      const outcome = await send(destinations, request, bearer, undefined, undefined, gate);
      lapsed = !outcome.ok && outcome.fault === 'lapsed';
      return outcome;
    },
    () => holder.secrets(),
  );
  // Past its deadline nothing was written: a refusal, as any lapsed send is.
  if (lapsed) return { type: 'refused', code: 'SEND_LAPSED' };
  if (!result.ok) return { type: 'refused', code: result.code };
  const body = JSON.stringify(result.response);
  const outcome = { ok: true, status: 200, body, mediaType: 'application/json' };
  return { type: 'answer', outcome, kind: 'subscription', account: null };
}
