// SPDX-License-Identifier: AGPL-3.0-only
//
// A refusal from the sandbox's grammars. `reason` is one of the contract's
// R1 reasons (docs/plan/sandbox-contract.md, section 9): a launcher request
// the proxy will not forward is `proxy refused`, a run's output its grammar
// refuses is `output refused`, a request I1 or an input tree I2 and I3
// refuse is `input refused`, a lockfile I5 refuses is `lockfile refused`, a
// site with no record is `unknown site`, a pin being made is `no pin`, a
// tree whose manifests miss the pin's digest is `pin mismatch` (I4), and a
// daemon reply that breaks the preamble's rules, or a site record or pin
// list that breaks its own, is `internal`. `why` names the clause that
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
  | 'too many entries'
  | 'tree entries'
  | 'tree size'
  | 'tree type'
  | 'tree name'
  | 'tree duplicate'
  | 'tree reserved'
  | 'tree config'
  | 'lockfile version'
  | 'package manager'
  | 'lockfile entry'
  | 'lockfile integrity'
  | 'lockfile resolved'
  | 'lockfile alias'
  | 'lockfile link'
  | 'lockfile name'
  | 'request key'
  | 'request value'
  | 'request path'
  | 'request content'
  | 'site id'
  | 'tree object'
  | 'tree listing'
  | 'pin image'
  | 'pin digest'
  | 'pin list'
  | 'site record'
  | 'record env'
  | 'base env'
  | 'candidate'
  | 'candidate record'
  | 'container record'
  | 'container count'
  | 'sweep';

/** R1's reasons (section 9), in the contract's order, `internal` last. */
export const REASONS = [
  'unavailable',
  'preflight failed',
  'drift',
  'unknown site',
  'no pin',
  'pin mismatch',
  'input refused',
  'lockfile refused',
  'fetch failed',
  'integrity mismatch',
  'image load failed',
  'proxy refused',
  'queue full',
  'deadline',
  'memory',
  'process limit',
  'output refused',
  'non-zero exit',
  'internal',
] as const;

export type Reason = (typeof REASONS)[number];

/** A caller's reading of a refusal's reason: anything not in R1 is `unavailable`. */
export const readReason = (value: unknown): Reason =>
  REASONS.find((reason) => reason === value) ?? 'unavailable';

export type Refused = {
  readonly ok: false;
  readonly reason:
    | 'unknown site'
    | 'no pin'
    | 'pin mismatch'
    | 'input refused'
    | 'lockfile refused'
    | 'proxy refused'
    | 'output refused'
    | 'internal';
  readonly why: Why;
};

export type SandboxResult<T> = ({ readonly ok: true } & T) | Refused;

export const refuse = (why: Why): Refused => ({ ok: false, reason: 'proxy refused', why });
export const fault = (why: Why): Refused => ({ ok: false, reason: 'internal', why });
