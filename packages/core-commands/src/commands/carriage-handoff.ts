// SPDX-License-Identifier: AGPL-3.0-only
//
// A carried deployment's handoff for one conversation call (live chat route
// B): its judgements (`carriage-origin.ts`) bound to the person's own token,
// the operation's wait, and, for a paid call, the broker's outside settings
// and the model the conversation was asked on (#1508).

import type { BusinessId, Database, VerifiedSubject } from '../../../core-records/src/index.ts';
import type { Handoff, PlanAsk } from '../../../core-custody/src/index.ts';
import { carriageHandoff } from './carriage-origin.ts';
import type { ModelBroker } from './model-call.ts';

/**
 * A carried deployment's handoff for a call on `operation`, made with the
 * person's own token, judged against the broker's settings as they are at
 * each judgement; none elsewhere.
 */
export function carriedBy(
  database: Database,
  businessId: BusinessId,
  presented: VerifiedSubject,
  broker: Pick<ModelBroker, 'carrier' | 'operations' | 'routes' | 'installation' | 'outsidePeople'>,
  asking: {
    readonly accessToken?: string;
    readonly operation: string;
    readonly model: string | null | undefined;
    /** The page task the request carries. */
    readonly page: string | null;
    /** The tasks the earlier exchanges sent may carry (#1666), judged with the page. */
    readonly sources?: readonly string[];
    /** The bound site pages the page field lists (#1988), judged again on the plan. */
    readonly sites?: PlanAsk['sites'];
  },
): { readonly carry?: (callId: string) => Handoff } {
  const { carrier } = broker;
  const { accessToken } = asking;
  const timeoutMs = broker.operations.get(asking.operation)?.timeoutMs ?? 0;
  if (carrier === undefined || accessToken === undefined) return {};
  const outside = { broker, model: asking.model };
  return {
    carry: carriageHandoff(database, businessId, presented, accessToken, {
      carrier,
      timeoutMs,
      outside,
      page: asking.page,
      sources: asking.sources ?? [],
      sites: asking.sites ?? [],
    }),
  };
}
