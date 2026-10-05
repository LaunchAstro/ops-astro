// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: the shape of a command's data effects, the builders its table is
// written with, and the class the gate reads, derived from them and never set
// by hand. Moved whole from `data-effects.ts`, which re-exports every shape
// here, to keep that file under the line limit.

/** `client`: a row that holds a task's id or a client's (ADR 0014); `business`: the agency's own. */
export type EffectScope = 'business' | 'client';

/** One record kind a command creates, changes or deletes: its table, and that table's scope. */
export interface RecordWrite {
  readonly kind: string;
  readonly scope: EffectScope;
}

/** Where new content comes from when it is not the app's own. */
export type Intake =
  | 'upload'
  | 'import'
  | 'provider-sync'
  | 'webhook'
  | 'page-capture'
  | 'public-form'
  | 'outside-person-input';

/** A provider write, a link or a stored credential; `forClient` when it is made for a client. */
export interface OutsideEffect {
  readonly provider: string;
  readonly forClient: boolean;
}

export interface DataEffects {
  readonly writes: readonly RecordWrite[];
  readonly intake: readonly Intake[];
  readonly outside: readonly OutsideEffect[];
  /** Admits a new outside person: an invitation or a login for a client person, guest or reviewer. */
  readonly access: boolean;
}

export const business = (...kinds: string[]): RecordWrite[] =>
  kinds.map((kind) => ({ kind, scope: 'business' }));
export const client = (...kinds: string[]): RecordWrite[] =>
  kinds.map((kind) => ({ kind, scope: 'client' }));
export const writing = (
  writes: readonly RecordWrite[],
  outside: readonly OutsideEffect[] = [],
): DataEffects => ({ writes, intake: [], outside, access: false });

export type DataClass = 'invitation' | 'client-data' | 'made-up-safe';

export interface ClassedEffects extends DataEffects {
  readonly class: DataClass;
}

/**
 * The class, from what the command does: `invitation` if it admits a new
 * outside person; `client-data` if it writes a client-scoped row, takes any
 * intake, or makes an outside effect for a client; `made-up-safe` otherwise.
 */
export function classOf(effects: DataEffects): DataClass {
  if (effects.access) return 'invitation';
  if (
    effects.writes.some((write) => write.scope === 'client') ||
    effects.intake.length > 0 ||
    effects.outside.some((effect) => effect.forClient)
  ) {
    return 'client-data';
  }
  return 'made-up-safe';
}
