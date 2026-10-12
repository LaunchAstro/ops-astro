// SPDX-License-Identifier: AGPL-3.0-only
//
// The drawer's questions whose answers were lost (`assistant/question-attempts.ts`),
// each with its Send again, drawn beside the allowance line above the selected
// tab's transcript. Send again is disabled while its resend is out.

import type { ReactElement } from 'react';
import { keyIn, type AssistantState } from '../assistant/chats.ts';
import type { LostQuestion } from '../assistant/question-attempts.ts';

export const LOST = 'We did not hear back. Send again to pick up its answer.';

/** The selected tab's lost questions. */
export const lostIn = (
  lost: readonly LostQuestion[],
  state: AssistantState,
): readonly LostQuestion[] => lost.filter((each) => keyIn(state, each.key) === state.selected);

/** How many of them are not being answered: each waits for its Send again. */
export const waiting = (lost: readonly LostQuestion[]): number =>
  lost.filter((each) => !each.resending).length;

export function withLost(allowance: ReactElement, lost: readonly LostQuestion[]): ReactElement {
  return (
    <>
      {allowance}
      {lost.map((each) => (
        <p
          key={each.id}
          className="aip__msg aip__msg--note"
          role="status"
          data-assistant="lost"
          data-line={each.line}
        >
          {LOST}{' '}
          <button
            className="btn btn--sm"
            type="button"
            data-assistant="send-again"
            disabled={each.resending}
            onClick={each.again}
          >
            Send again
          </button>
        </p>
      ))}
    </>
  );
}
