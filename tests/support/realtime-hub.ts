// SPDX-License-Identifier: AGPL-3.0-only
//
// A stand-in for Supabase Realtime's private broadcast channels over the test
// database and its shim (`realtime-shim.sql`), for the carriage cases.
//
// * A join is admitted by the join function the migrations write, asked as
//   the `authenticated` role with the subscriber's claims set, as the
//   policies on `realtime.messages` ask it: receive on any carriage topic,
//   send on a call topic only.
// * Access is cached per subscription, as hosted caches it per connection: a
//   joined subscriber keeps hearing after its standing is withdrawn, until it
//   leaves or presents a new token (`setAuth`), which is judged again.
// * A database broadcast (`realtime.send`, stored by the shim) is delivered
//   to the topic's admitted subscribers. A subscriber's own send is delivered
//   to the topic's other subscribers and stored nowhere.
//
// It is not evidence that a hosted project enforces the policies; the live
// probe with two real logins is.

import postgres from 'postgres';

export interface Claims {
  readonly sub: string;
  readonly [claim: string]: unknown;
}

/**
 * Claims as the provider issues them: GoTrue stamps every token's first
 * sign-in in `amr`, so claims that name none were signed in now.
 */
export function asIssued<T extends Record<string, unknown>>(claims: T): T {
  return 'amr' in claims
    ? claims
    : { ...claims, amr: [{ method: 'password', timestamp: Math.floor(Date.now() / 1000) }] };
}

export interface Heard {
  readonly event: string;
  readonly payload: unknown;
}

export interface Subscription {
  readonly topic: string;
  /** Everything delivered to this subscriber, in order. */
  readonly heard: Heard[];
  /** A WebSocket broadcast: refused without send access, else delivered to the others, never stored. */
  send(event: string, payload: unknown): 'sent' | 'refused';
  /** A new token: access is judged again, and a refusal ends the subscription. */
  setAuth(claims: Claims): Promise<boolean>;
  leave(): void;
}

export interface RealtimeHub {
  /** Joins `topic` as the holder of `claims`, or `refused` as the receive policy refuses it. */
  join(topic: string, claims: Claims): Promise<Subscription | 'refused'>;
  close(): Promise<void>;
}

interface Member {
  readonly topic: string;
  readonly heard: Heard[];
  mayReceive: boolean;
  maySend: boolean;
  left: boolean;
}

const CALL_TOPIC = /^carry:[^:]+:call:[^:]+$/u;

/** The join function's answer for `topic`, asked as Realtime asks it: as `authenticated`, the claims set. */
async function judged(sql: postgres.Sql, topic: string, claims: Claims): Promise<boolean> {
  return await sql.begin(async (tx) => {
    await tx`set local role authenticated`;
    await tx`select set_config('request.jwt.claims', ${JSON.stringify(asIssued(claims))}, true)`;
    await tx`select set_config('realtime.topic', ${topic}, true)`;
    const [row] = await tx<{ ok: boolean }[]>`
      select public.ops_carry_may_join(realtime.topic()) as ok`;
    return row?.ok === true;
  });
}

/** A joined member's handle: its sends, its new tokens, its leaving. */
function subscription(
  sql: postgres.Sql,
  member: Member,
  members: Set<Member>,
  deliver: (topic: string, heard: Heard, except: Member) => void,
): Subscription {
  return {
    topic: member.topic,
    heard: member.heard,
    send: (event, payload) => {
      if (member.left || !member.maySend) return 'refused';
      deliver(member.topic, { event, payload }, member);
      return 'sent';
    },
    setAuth: async (next) => {
      const ok = await judged(sql, member.topic, next);
      member.mayReceive = ok;
      member.maySend = ok && CALL_TOPIC.test(member.topic);
      if (!ok) member.left = true;
      return ok;
    },
    leave: () => {
      member.left = true;
      members.delete(member);
    },
  };
}

/** The hub over the database at `adminUrl`, which holds the shim and the migrations. */
export async function realtimeHub(adminUrl: string): Promise<RealtimeHub> {
  const sql = postgres(adminUrl, { max: 2 });
  const members = new Set<Member>();

  const deliver = (topic: string, heard: Heard, except?: Member): void => {
    for (const member of members) {
      if (member !== except && !member.left && member.mayReceive && member.topic === topic) {
        member.heard.push(heard);
      }
    }
  };

  const listening = await sql.listen('realtime_shim', (text) => {
    const message = JSON.parse(text) as { topic: string; event: string; payload: unknown };
    deliver(message.topic, { event: message.event, payload: message.payload });
  });

  return {
    join: async (topic, claims) => {
      if (!(await judged(sql, topic, claims))) return 'refused';
      const member: Member = {
        topic,
        heard: [],
        mayReceive: true,
        maySend: CALL_TOPIC.test(topic),
        left: false,
      };
      members.add(member);
      return subscription(sql, member, members, deliver);
    },
    close: async () => {
      await listening.unlisten();
      await sql.end();
    },
  };
}
