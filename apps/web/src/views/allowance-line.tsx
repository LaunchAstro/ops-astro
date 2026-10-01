// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04 (U10; U7-SCORE's fourth fork): the drawer's planning allowance line.
// From before the first message it says what is left of the business's
// planning budget; once the tab's conversation has started, it adds that
// conversation's own spend and what is still held for it. It reads
// `conversation.allowance`, the team's only, since the budget is the
// business's. A refused or unavailable read draws no line: the line informs,
// and the broker's own check under the cap is what refuses a reply.

import { useEffect, useState, type ReactElement } from 'react';
import type {
  AllowanceResult,
  PlanningAllowanceView,
} from '../../../../packages/core-wire/src/index.ts';
import { isRefusal, isUnavailable, type OperationsClient } from '../operations/client.ts';

export interface AllowanceLineProps {
  readonly client: OperationsClient;
  /** The selected tab's conversation, or null before its first message. */
  readonly conversationId: string | null;
}

const money = (minor: number, currency: string): string =>
  `${currency} ${(minor / 100).toFixed(2)}`;

function words(allowance: PlanningAllowanceView, started: boolean): string {
  const { currency, conversation } = allowance;
  const left = `Planning allowance: ${money(allowance.leftMinor, currency)} left of ${money(allowance.limitMinor, currency)}.`;
  if (!started) return left;
  return `${left} This conversation: ${money(conversation.spentMinor, currency)} spent, ${money(conversation.heldMinor, currency)} held.`;
}

export function AllowanceLine(props: AllowanceLineProps): ReactElement | null {
  const { client, conversationId } = props;
  const [allowance, setAllowance] = useState<PlanningAllowanceView | null>(null);
  useEffect(() => {
    let current = true;
    const body = conversationId === null ? {} : { conversationId };
    const load = async (): Promise<void> => {
      const answer = await client.read<AllowanceResult>('conversation.allowance', body);
      if (!current) return;
      setAllowance(isRefusal(answer) || isUnavailable(answer) ? null : answer.value.allowance);
    };
    void load();
    return () => {
      current = false;
    };
  }, [client, conversationId]);
  if (allowance === null) return null;
  return (
    <p className="aip__msg aip__msg--note" data-assistant="allowance">
      {words(allowance, conversationId !== null)}
    </p>
  );
}
