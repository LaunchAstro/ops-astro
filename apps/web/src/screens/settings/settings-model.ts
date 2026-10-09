// SPDX-License-Identifier: AGPL-3.0-only
//
// What `/settings` hands its form: `useSettings`'s answer and a conflict's
// shape. Moved whole from use-settings.ts to keep that file under the line
// limit; use-settings.ts re-exports both.

import type { ReadState } from '../../data/authorised-read.ts';
import type { StepUpAsk } from '../../records/use-money-command.ts';
import type {
  CapabilitiesResult,
  SettingsReadResult,
  SettingView,
} from '../../../../../packages/core-wire/src/index.ts';
import type { Confirmed, Draft, Which } from './confirmed.ts';

/** A write the server would not take because somebody else wrote first. */
export interface Conflict {
  readonly which: Which;
  readonly draft: Draft;
  /** The server's refusal, verbatim, so the code can be quoted to somebody. */
  readonly because: string;
}

export interface SettingsModel {
  readonly read: ReadState<SettingsReadResult>;
  readonly capabilities: ReadState<CapabilitiesResult>;
  /** The read answered with rows, so the server's values may be drawn. */
  readonly answered: boolean;
  /**
   * Nobody answered, so this session's own confirmed write is all there is.
   * Never true for a refused read: the server declined, and nothing stands in.
   */
  readonly fallback: boolean;
  readonly confirmed: Confirmed;
  readonly closed: boolean;
  readonly busy: Which | null;
  /** Every row closed; `disabledFor` adds the row's own grant (four-eyes: spend:decide). */
  readonly disabled: boolean;
  readonly disabledFor: (which: Which) => boolean;
  readonly because: string | null;
  /** The money step-up prompt, while a refused threshold waits on a code. */
  readonly stepUp: StepUpAsk | null;
  readonly conflict: Conflict | null;
  readonly rowFor: (which: Which) => SettingView | null;
  readonly save: (which: Which, value: Draft) => void;
  /** The second explicit press: the person choosing to overwrite what they saw. */
  readonly writeOver: () => void;
  /** Asks the settings read again, after it did not come back. */
  readonly retry: () => void;
  /** Something this screen decided, not the server. Never dressed as a refusal. */
  readonly complain: (text: string) => void;
  /** Read the settings again, as a write elsewhere on the page asks. */
  readonly reload: () => void;
  /** Only owner/generation changes remount the priority editor. */
  readonly priorityOwnerKey: string;
  readonly priorityEditable: boolean;
  readonly priorityPending: boolean;
  readonly priorityUnknown: boolean;
}
