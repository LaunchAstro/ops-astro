// SPDX-License-Identifier: AGPL-3.0-only
//
// S0-5: what each command does to data, declared beside its permission key,
// and the class the gate reads, derived from it and never set by hand.

import type { CommandName } from './surface.ts';

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

export type DataClass = 'invitation' | 'client-data' | 'made-up-safe';

export interface ClassedEffects extends DataEffects {
  readonly class: DataClass;
}

export function classOf(_effects: DataEffects): DataClass {
  throw new Error('S0-5: the class rule is not built');
}

export const COMMAND_EFFECTS: { readonly [Name in CommandName]: DataEffects } = {} as {
  readonly [Name in CommandName]: DataEffects;
};
