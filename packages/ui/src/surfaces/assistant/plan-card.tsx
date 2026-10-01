// SPDX-License-Identifier: AGPL-3.0-only
//
// AW-04: the plan as a card in the chat (U7-SCORE's recommendation, owner line
// 67). The card shows the steps, the rough cost (the ceiling the words name),
// what planning has spent so far (U10), and the version on screen beside the
// one accept, so the click names the version the person read (U7).
//
// After the click it is the approved card: "Exact words kept", the task's
// link and "Run started", the only place the person learns the click changed
// nothing live. A newer version in the same chat makes the card stale, with
// no accept. Every word on it is text: nothing a model wrote is markup.

import type { ReactElement } from 'react';
import { money } from '../agent/format.ts';
import type { AssistantPlan } from './types.ts';

function Approved(props: { readonly plan: AssistantPlan }): ReactElement {
  return (
    <div className="aip__plan-done" data-plan="approved">
      <span className="aip__plan-k">Approved</span>
      <span>Exact words kept</span>
      <a href={props.plan.task.href} data-plan="task">
        {props.plan.task.label}
      </a>
      <span>Run started</span>
    </div>
  );
}

function Offer(props: {
  readonly plan: AssistantPlan;
  readonly onAccept: (() => void) | undefined;
}): ReactElement | null {
  const { plan } = props;
  if (plan.state === 'stale') {
    return (
      <p className="aip__plan-meta" data-plan="stale">
        Replaced by Version {plan.replacedBy ?? plan.version + 1}. Accept the newer card.
      </p>
    );
  }
  if (props.onAccept === undefined) return null;
  const onAccept = props.onAccept;
  return (
    <div className="aip__plan-act">
      <span className="aip__plan-meta" data-plan="version">
        Version {plan.version}
      </span>
      <button
        className="btn btn--primary btn--sm"
        type="button"
        data-plan="accept"
        disabled={plan.state === 'accepting'}
        onClick={onAccept}
      >
        Accept plan
      </button>
    </div>
  );
}

export function PlanCard(props: {
  readonly plan: AssistantPlan;
  readonly onAccept: (() => void) | undefined;
}): ReactElement {
  const { plan } = props;
  return (
    <div className="aip__plan" data-plan="card" data-version={plan.version}>
      <span className="aip__plan-k">Plan</span>
      <ol className="aip__plan-steps">
        {plan.steps.map((step, at) => (
          // Two steps may share a title; the position is the stable key.
          // oxlint-disable-next-line react/no-array-index-key -- the list is never reordered
          <li key={at} data-plan="step">
            {step}
          </li>
        ))}
      </ol>
      <p className="aip__plan-words" data-plan="words">
        {plan.text}
      </p>
      <p className="aip__plan-meta" data-plan="cost">
        Rough cost: up to {money(plan.ceilingMinor, plan.currency)}
      </p>
      <p className="aip__plan-meta" data-plan="spend">
        Planning so far: {money(plan.spendMinor, plan.currency)}
      </p>
      {plan.refusal === null ? null : (
        <p className="aip__plan-meta aip__plan-refused" role="alert" data-plan="refusal">
          {plan.refusal}
        </p>
      )}
      {plan.state === 'approved' ? (
        <Approved plan={plan} />
      ) : (
        <Offer plan={plan} onAccept={props.onAccept} />
      )}
    </div>
  );
}
