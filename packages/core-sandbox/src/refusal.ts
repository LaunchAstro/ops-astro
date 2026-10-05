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
  | 'reply body'
  | 'tar block'
  | 'tar type'
  | 'tar magic'
  | 'tar checksum'
  | 'tar size'
  | 'tar mode'
  | 'tar name'
  | 'tar parent'
  | 'tar duplicate'
  | 'tar link'
  | 'tar end'
  | 'too many entries';

/** R1's reasons (section 9). */
export const REASONS: readonly string[] = [];

export type Reason =
  | 'unavailable'
  | 'preflight failed'
  | 'drift'
  | 'unknown site'
  | 'no pin'
  | 'pin mismatch'
  | 'input refused'
  | 'lockfile refused'
  | 'fetch failed'
  | 'integrity mismatch'
  | 'image load failed'
  | 'proxy refused'
  | 'queue full'
  | 'deadline'
  | 'memory'
  | 'process limit'
  | 'output refused'
  | 'non-zero exit'
  | 'internal';

/** A caller's reading of the reason in an answer: anything not in R1 is `unavailable`. */
export const readReason = (value: unknown): Reason => value as Reason;

export type Refused = {
  readonly ok: false;
  readonly reason: 'proxy refused' | 'output refused' | 'internal';
  readonly why: Why;
};

export type SandboxResult<T> = ({ readonly ok: true } & T) | Refused;

export const refuse = (why: Why): Refused => ({ ok: false, reason: 'proxy refused', why });
export const fault = (why: Why): Refused => ({ ok: false, reason: 'internal', why });
