// SPDX-License-Identifier: AGPL-3.0-only
//
// The execution map's inspector (MP-6-3, TG-07, DS-TASK-14): everything about
// the selected step, under the map, without leaving the page. The planned
// layer (the step, what it comes after) and the observed layer (each run's own
// condition) are said apart, never merged. A step whose newest run has a gate
// leads with the one gate card (DS-TASK-7 `.gate`), binding its exact version
// and digest; the digest wraps rather than overflowing a phone (D-16).

import type { ReactElement } from 'react';
import { Empty } from '../../primitives/Absence.tsx';
import type { MapNode, MapStep } from '../../state/execution-map.ts';
import { money, words } from './format.ts';

function Fact(props: { readonly k: string; readonly children: string }): ReactElement {
  return (
    <div className="sout__row" data-map-fact={props.k}>
      <span className="tf__k">{props.k}</span>
      <span>{props.children}</span>
    </div>
  );
}

function runLine(run: MapNode): string {
  const { condition, outcome, fault, lease } = run.observed;
  const bits = [words(condition)];
  if (outcome !== null) bits.push(words(outcome));
  if (fault !== null) bits.push(`fault: ${fault}`);
  if (lease !== null) bits.push(`lease ${lease.state}`);
  return `${run.nodeId}: ${bits.join(', ')}`;
}

function moneyLine(run: MapNode): string {
  const { heldMinor, spentMinor, currency } = run.observed;
  // Absent money is not recorded, never 0.
  const held = heldMinor === null ? 'held not recorded' : `held ${money(heldMinor, currency)}`;
  const spent = spentMinor === null ? 'spent not recorded' : `spent ${money(spentMinor, currency)}`;
  return `${held}; ${spent}`;
}

export function MapInspector(props: { readonly step: MapStep | null }): ReactElement {
  const { step } = props;
  if (step === null) {
    return (
      <div className="tg__insp" data-map="inspector">
        <Empty
          look="inline"
          title="Nothing selected. Choose a step to see what it needs and what its runs did."
        />
      </div>
    );
  }
  const newest = step.runs.at(-1);
  const waiting = step.after.filter((one) => !one.satisfied).map((one) => one.key);
  return (
    <div className="tg__insp" data-map="inspector" data-map-step={step.key}>
      <div className="sb__sh">
        <span className="sb__k">{step.key} · planned step</span>
        <span className="sb__meta">{step.state.word}</span>
      </div>
      <p className="tg__insp__t">{step.title}</p>
      {step.gate === null ? null : (
        <div className={step.gate.state === 'pending' ? 'gate gate--armed' : 'gate'}>
          <span className="gate__mark" aria-hidden="true" />
          <div>
            <div className="gate__word">Human approval gate · {words(step.gate.state)}</div>
            <p className="gate__say" data-map="binds">
              Binds v{step.gate.version} · {step.gate.digest}.
            </p>
          </div>
        </div>
      )}
      <div className="tg__insp__facts">
        <Fact k="Needs">
          {step.after.length === 0
            ? 'Nothing: this step starts the plan'
            : step.after.map((one) => one.key).join(' + ')}
        </Fact>
        {waiting.length === 0 ? null : <Fact k="Waiting on">{waiting.join(' + ')}</Fact>}
        <Fact k="Runs">
          {step.runs.length === 0 ? 'None yet: planned' : step.runs.map(runLine).join(' · ')}
        </Fact>
        {newest === undefined ? null : <Fact k="Money">{moneyLine(newest)}</Fact>}
        {newest === undefined ? null : (
          <Fact k="Effect">{newest.observed.effectObserved ? 'Observed' : 'Not observed'}</Fact>
        )}
      </div>
    </div>
  );
}
