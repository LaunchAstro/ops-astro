// SPDX-License-Identifier: AGPL-3.0-only
//
// A refusal from the sandbox's grammars. `reason` is one of the contract's
// R1 reasons (docs/plan/sandbox-contract.md, section 9): a launcher request
// the proxy will not forward is `proxy refused`, and a daemon reply that
// breaks the preamble's rules is `internal`. `why` names the clause that
// refused, for the person reading the refusal and for the corpus tests.

export type Why =
  | 'not utf-8'
  | 'too large'
  | 'too deep'
  | 'duplicate key'
  | 'json syntax'
  | 'request line'
  | 'version'
  | 'path'
  | 'query'
  | 'header'
  | 'transfer-encoding'
  | 'body'
  | 'second request'
  | 'unknown route'
  | 'container id'
  | 'image id'
  | 'image slot'
  | 'create body'
  | 'reply status'
  | 'reply body';

export type Refused = {
  readonly ok: false;
  readonly reason: 'proxy refused' | 'internal';
  readonly why: Why;
};

export type Result<T> = ({ readonly ok: true } & T) | Refused;

export const refuse = (why: Why): Refused => ({ ok: false, reason: 'proxy refused', why });
export const fault = (why: Why): Refused => ({ ok: false, reason: 'internal', why });
