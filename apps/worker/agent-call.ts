// SPDX-License-Identifier: AGPL-3.0-only
//
// The worker's one way to the API: an agent call through the command line's
// own entry (`apps/cli/client.ts`), settled to a success's body, a refusal or
// a fault.

import { randomUUID } from 'node:crypto';
import { createCli, isRefusal, type CliAnswer, type Transport } from '../cli/client.ts';
import type { Bearer } from './sign-in.ts';

export interface Answered {
  readonly body: Record<string, unknown>;
  readonly detail: Record<string, unknown>;
}

/** What ends the attempt instead: a refusal, or no usable answer. */
export type Unanswered =
  | { readonly refused: { readonly code: string; readonly names: readonly string[] } }
  | { readonly fault: { readonly status: number } };

export type Call = (verb: string, body: object) => Promise<Answered | Unanswered>;

/** The agent login a call presents, and the transport it goes over. */
export interface AgentLogin {
  readonly transport: Transport;
  readonly businessKey: string;
  /** The agent's own login: a bearer it renews (`sign-in.ts`), or one as handed, never renewed. */
  readonly credential: Bearer | string;
}

/**
 * One agent call, under `delegation` when there is one. Every call carries an
 * operation id, reads included (`agent-envelope.ts`), and an answer lost in
 * transit is asked for once more under the same id, so it replays. A bearer
 * the API answers `AUTH_SESSION_EXPIRED` is renewed once and the same call,
 * the same id, sent again: the door refused it before the register saw it.
 */
export function agentCall(login: AgentLogin, delegation?: string): Call {
  const { credential } = login;
  const send = async (presented: string, verb: string, sent: Readonly<Record<string, unknown>>) => {
    const cli = createCli({
      entry: 'agent',
      businessKey: encodeURIComponent(login.businessKey),
      credential: presented,
      ...(delegation === undefined ? {} : { delegation }),
      transport: login.transport,
    });
    return await cli.run(verb, sent).catch(async () => await cli.run(verb, sent));
  };
  return async (verb, body) => {
    const sent = { operationId: randomUUID(), ...body };
    const fixed = typeof credential === 'string';
    const first = settle(await send(fixed ? credential : await credential.current(), verb, sent));
    const expired = 'refused' in first && first.refused.code === 'AUTH_SESSION_EXPIRED';
    if (fixed || !expired) return first;
    const renewed = await credential.renew();
    return renewed === undefined ? first : settle(await send(renewed, verb, sent));
  };
}

/** A success's body, or the outcome that ends this attempt. No credential is ever in either. */
function settle(answer: CliAnswer): Answered | Unanswered {
  const body = answer.body as Record<string, unknown> | undefined;
  if (answer.status >= 200 && answer.status < 300 && body !== undefined) {
    return { body, detail: (body['detail'] as Record<string, unknown> | undefined) ?? {} };
  }
  if (isRefusal(answer)) {
    const refusal = body as { code: string; names?: readonly string[] };
    return { refused: { code: refusal.code, names: refusal.names ?? [] } };
  }
  return { fault: { status: answer.status } };
}
