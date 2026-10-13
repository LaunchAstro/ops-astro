// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried call's two judgements (live chat route B), and the handoff that
// gives them to the carried custody (`core-custody/src/carriage.ts`).
//
// Each takes every lock the call's authority rests on, in one order: the call
// with its carriers row (still dispatched; at the offer not yet offered, at
// the send recorded for this runner), the conversation (the person's own, not
// purged), its page task (no client's), the agent's open membership, the
// agent's actor (active, the carrier), the person's conversation grants
// (`nowait`: contention refuses, nothing sent), then their ending keys,
// shared. It judges at the instant read after them. A revocation, client
// link, membership leave, deactivation, purge or session ending takes one of
// those locks, so it commits before the judgement, which sees it, or waits.
//
// The send is recorded and committed first (runner, `request_at`, `send_by`,
// `answer_by`), so the sweep never takes a send for none; the request goes only
// once the send judgement passes after it. That judgement's transaction holds
// its locks until the agent reports the write or a refusal, or W after the
// accept was heard, on the pool's one connection: nothing needs a second.

import type { Carrier, Handoff, Judged } from '../../../core-custody/src/index.ts';
import { SEND_WINDOW_MS } from '../../../core-custody/src/index.ts';
import {
  advisoryLock,
  sessionEnded,
  sessionKey,
  slotOf,
  subjectKey,
  subjectsOf,
  TASK_SPINE,
  withSession,
  type BusinessId,
  type Database,
  type Session,
  type TenantQuery,
  type VerifiedSubject,
} from '../../../core-records/src/index.ts';
import { holdCoveringGrants, lockedInstant } from '../../../core-runtime/src/index.ts';
import { CONVERSATION_ANSWER } from '../../../core-connectors/src/index.ts';
import { holdsOwnConversations } from './conversations.ts';
import type { ModelBroker } from './model-call.ts';

const CLIENT = slotOf(TASK_SPINE, 'client');

/** After the send's window and the model's wait, ten seconds more: the latest an answer settles. */
const SETTLE_MARGIN_MS = 10_000;

const LOST = { ok: false, code: 'AUTHORITY_LOST' } as const;

const nothing = (): void => {};

interface Asked {
  readonly presented: VerifiedSubject;
  readonly accessToken: string;
  readonly callId: string;
  readonly carrier: Carrier;
}

interface Called {
  readonly state: string;
  readonly conversation_id: string;
  readonly agent: string;
  readonly offered: boolean;
  readonly runner: string | null;
}

/** The token's `exp`, in milliseconds; the door verified the token, this reads it. */
function expiresAt(token: string): number {
  try {
    const { exp } = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as {
      exp?: unknown;
    };
    return typeof exp === 'number' ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** Locks 1 to 3: the call and its carriers row, the conversation, its page task. */
async function heldCall(
  tx: TenantQuery,
  session: Session,
  callId: string,
  mode: 'offer' | { readonly runner: string },
): Promise<Called | Judged> {
  const [call] = await tx.query<Called>(
    `select c.state, c.conversation_id, k.agent_actor_id as agent,
            k.offered_at is not null as offered, k.runner::text as runner
       from public.model_calls c
       join public.model_call_carriers k on k.business_id = c.business_id and k.call_id = c.id
      where c.business_id = $1 and c.id = $2
      for share of c`,
    [tx.businessId, callId],
  );
  const due = mode === 'offer' ? !call?.offered : call?.runner === mode.runner;
  if (call?.state !== 'dispatched' || !due) return { ok: false, code: 'DECISION_STALE' };
  const [conversation] = await tx.query<{
    readonly own: boolean;
    readonly purged: boolean;
    readonly page: string | null;
  }>(
    `select owner_actor_id = $3 as own, body_purged_at is not null as purged,
            scope_record_id as page
       from public.conversations where business_id = $1 and id = $2 for share`,
    [tx.businessId, call.conversation_id, session.actorId],
  );
  if (conversation === undefined || !conversation.own || conversation.purged) return LOST;
  if (conversation.page === null) return call;
  const [page] = await tx.query<{ readonly client: string | null }>(
    `select ${CLIENT} as client from public.records where business_id = $1 and id = $2 for share`,
    [tx.businessId, conversation.page],
  );
  if (page === undefined) return LOST;
  return page.client === null ? call : { ok: false, code: 'CLIENT_MODEL_USE_OFF' };
}

/** Locks 4 and 5: whether the agent is still an open member, active, and the carrier. */
async function heldAgent(tx: TenantQuery, call: Called, carrier: Carrier): Promise<boolean> {
  const member = await tx.query(
    `select 1 from public.conversation_agent_members
      where business_id = $1 and conversation_id = $2 and agent_actor_id = $3 and left_at is null
      for share`,
    [tx.businessId, call.conversation_id, call.agent],
  );
  const [agent] = await tx.query<{ readonly active: boolean }>(
    `select active from public.actors where business_id = $1 and id = $2 for share`,
    [tx.businessId, call.agent],
  );
  return member.length > 0 && agent?.active === true && call.agent === carrier.agent;
}

/** Every lock in order, then the judgement at the instant after them. */
async function judgeCarriage(
  tx: TenantQuery,
  session: Session,
  asked: Asked,
  mode: 'offer' | { readonly runner: string },
): Promise<Judged> {
  const call = await heldCall(tx, session, asked.callId, mode);
  if ('ok' in call) return call;
  const carried = await heldAgent(tx, call, asked.carrier);
  const held = new Set(await holdCoveringGrants(tx, subjectsOf(session), 'conversation', 'nowait'));
  await advisoryLock(tx, subjectKey(asked.presented.subject), 'shared');
  if (asked.presented.sessionId !== undefined) {
    await advisoryLock(tx, sessionKey(asked.presented.sessionId), 'shared');
  }
  const at = await lockedInstant(tx);
  const listed = session.personId !== null && asked.carrier.people.includes(session.personId);
  if (!carried || !listed || (await sessionEnded(tx, asked.presented))) return LOST;
  if (expiresAt(asked.accessToken) <= Date.parse(at)) return LOST;
  return (await holdsOwnConversations(tx, session, { at, held })) ? { ok: true } : LOST;
}

/** Grant contention under the `nowait` hold: nothing was sent, so the call is released. */
const busy = (cause: unknown): { readonly ok: false; readonly code: string } => {
  if ((cause as { readonly code?: unknown }).code !== '55P03') throw cause;
  return { ok: false, code: 'AUTHORITY_BUSY' };
};

/** The offer judgement; passing, `offered_at` is set and its trigger rings the doorbell, ids only. */
async function offer(database: Database, businessId: BusinessId, asked: Asked): Promise<Judged> {
  const judged = await withSession(database, businessId, asked.presented, async (tx, session) => {
    const passed = await judgeCarriage(tx, session, asked, 'offer');
    if (!passed.ok) return passed;
    await tx.query(
      `update public.model_call_carriers set offered_at = clock_timestamp()
        where business_id = $1 and call_id = $2 and offered_at is null`,
      [tx.businessId, asked.callId],
    );
    return passed;
  }).catch(busy);
  return 'ok' in judged ? judged : LOST;
}

/** The send recorded, committed: the runner, `request_at`, `send_by` (the agent's) and `answer_by`. */
async function recordSend(
  database: Database,
  businessId: BusinessId,
  callId: string,
  accept: { readonly runner: string; readonly acceptedAt: number; readonly timeoutMs: number },
): Promise<boolean> {
  const recorded = await database
    .withBusiness(
      businessId,
      async (tx) =>
        await tx.query(
          `update public.model_call_carriers
              set runner = $3::uuid, request_at = clock_timestamp(),
                  send_by = to_timestamp($4::double precision / 1000),
                  answer_by = clock_timestamp() + make_interval(secs => $5::double precision)
            where business_id = $1 and call_id = $2 and offered_at is not null and runner is null
            returning call_id`,
          [
            businessId,
            callId,
            accept.runner,
            accept.acceptedAt + SEND_WINDOW_MS,
            (SEND_WINDOW_MS + accept.timeoutMs + SETTLE_MARGIN_MS) / 1000,
          ],
        ),
    )
    .catch(() => []);
  return recorded.length > 0;
}

type Fenced = Awaited<ReturnType<Handoff['fence']>>;

/** The send judgement, whose transaction holds its locks until released or W after `heardAt`. */
function holdSend(
  database: Database,
  businessId: BusinessId,
  asked: Asked,
  accept: { readonly runner: string; readonly heardAt: number },
): Promise<Fenced> {
  return new Promise<Fenced>((ready) => {
    let letGo = nothing;
    const released = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    const running = withSession(database, businessId, asked.presented, async (tx, session) => {
      const passed = await judgeCarriage(tx, session, asked, { runner: accept.runner });
      if (!passed.ok) {
        ready(passed);
        return;
      }
      await tx.query(`set local idle_in_transaction_session_timeout = '10s'`);
      ready({
        ok: true,
        release: async () => {
          letGo();
          await running;
        },
      });
      const left = Math.max(0, accept.heardAt + SEND_WINDOW_MS - Date.now());
      await Promise.race([
        released,
        new Promise((resolve) => {
          setTimeout(resolve, left);
        }),
      ]);
    })
      .catch((cause: unknown) => {
        ready(busy(cause));
      })
      .catch(() => {
        ready({ ok: false, code: 'CARRIAGE_UNAVAILABLE' });
      })
      .finally(() => {
        // A session that no longer resolves answered nothing above: its authority is gone.
        ready(LOST);
      });
  });
}

/**
 * The handoff for one carried call: its two judgements under the person's
 * own session, with `timeoutMs` the model's wait, which `answer_by` allows for.
 */
export function carriageHandoff(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  accessToken: string,
  carrier: Carrier,
  timeoutMs: number,
): (callId: string) => Handoff {
  return (callId) => {
    const asked: Asked = { presented, accessToken, callId, carrier };
    return {
      businessId,
      callId,
      accessToken,
      offer: async () => await offer(database, businessId, asked),
      fence: async ({ runner, acceptedAt, heardAt }) => {
        const accept = { runner, acceptedAt, timeoutMs };
        if (!(await recordSend(database, businessId, callId, accept))) {
          return { ok: false, code: 'DECISION_STALE' };
        }
        return await holdSend(database, businessId, asked, { runner, heardAt });
      },
    };
  };
}

/** A carried deployment's handoff for the call, made with the person's own token; none elsewhere. */
export function carriedBy(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  accessToken: string | undefined,
  broker: Pick<ModelBroker, 'carrier' | 'operations'>,
): { readonly carry?: (callId: string) => Handoff } {
  const { carrier } = broker;
  const timeoutMs = broker.operations.get(CONVERSATION_ANSWER.key)?.timeoutMs ?? 0;
  if (carrier === undefined || accessToken === undefined) return {};
  return {
    carry: carriageHandoff(database, businessId, presented, accessToken, carrier, timeoutMs),
  };
}
