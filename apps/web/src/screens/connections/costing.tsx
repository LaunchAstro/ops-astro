// SPDX-License-Identifier: AGPL-3.0-only
//
// Connections & signal section 009, skill costing (MP-14-9; R61 numbers it
// 009, below the night round and above the per-client region). One read,
// `finance.skill_costs`, draws the lede, a row per skill and the attribution
// foot per currency.
//
// The section is not drawn when nothing the caller may see has run, nor for a
// caller the read refuses. A skill's figure has three branches: a mean with its
// spread, one run's figure in words, or a sentence when no run used the skill
// alone; never a zero. Nothing here acts (CS-14.15): the skill name is the door
// to its process document, drawn unavailable with its reason until Docs exists
// (MP-7-6 makes it open).

import { useEffect, useState, type ReactElement } from 'react';
import type {
  AttributionSplitView,
  SkillCostView,
  SkillCostsResult,
} from '../../../../../packages/core-wire/src/index.ts';
import { isRefusal, isUnavailable, type OperationsClient } from '../../operations/client.ts';
import { money } from '../../views/proposal-record.tsx';
import { plural } from './signal-view.ts';

type Costing =
  | { readonly state: 'absent' }
  | { readonly state: 'shown'; readonly costing: NonNullable<SkillCostsResult['costing']> }
  | { readonly state: 'not shown'; readonly because: string };

const cost = (minor: string, currency: string): string => money(Number(minor), currency);
const units = (count: string): string => Number(count).toLocaleString('en-AU');

function Figure(props: { readonly row: SkillCostView }): ReactElement {
  const { figure, currency, usage } = props.row;
  if (figure.kind === 'mean') {
    return (
      <div className="skc__fig" data-figure="mean">
        <p>
          <strong>{cost(figure.mean, currency)}</strong> mean
        </p>
        <p className="t-2" data-figure-spread>
          {cost(figure.lo, currency)}–{cost(figure.hi, currency)}
        </p>
        {usage.meanIn === null || usage.meanOut === null ? null : (
          <p className="t-2" data-figure-units>
            {units(usage.meanIn)} in · {units(usage.meanOut)} out
          </p>
        )}
      </div>
    );
  }
  if (figure.kind === 'one') {
    return (
      <div className="skc__fig skc__fig--thin" data-figure="one">
        <p>
          <strong>{cost(figure.amount, currency)}</strong> one run
        </p>
        <p className="t-2">Not an average — this process has run once.</p>
      </div>
    );
  }
  return (
    <div className="skc__fig skc__fig--none" data-figure="none">
      <p className="t-2">
        No run has used this process on its own, so nothing here can be costed from it.
      </p>
    </div>
  );
}

function observed(row: SkillCostView): string {
  const tasks = plural(row.tasks, 'task');
  const own =
    row.soloRuns === 0
      ? `no run of its own, across ${tasks}`
      : `${plural(row.soloRuns, 'run')} of its own across ${tasks}`;
  const shared =
    row.sharedRuns === 0
      ? ''
      : ` · ${plural(row.sharedRuns, 'further run')} alongside another skill, counted and not averaged`;
  const unpriced =
    row.unpricedRuns === 0 ? '' : ` · ${plural(row.unpricedRuns, 'run')} with no known cost yet`;
  return `${own}${shared}${unpriced}`;
}

function SkillRow(props: { readonly row: SkillCostView }): ReactElement {
  const { row } = props;
  const { figure } = row;
  const unnamed = row.models.unnamedCalls;
  // Printed beside the headline figure only where the two differ.
  const finished =
    figure.kind === 'mean' && figure.finishedMean !== figure.mean ? figure.finishedMean : null;
  return (
    <li className="skc__row" data-skill={row.skillId}>
      <p>
        <a data-skill-doc aria-disabled="true" title={row.document.reason}>
          {row.name}
        </a>
      </p>
      <Figure row={row} />
      <p data-observed>
        <span className="t-2">Observed</span> {observed(row)}
      </p>
      <p data-models>
        <span className="t-2">On</span> {row.models.ids.join(' ')}
        {unnamed === 0 ? '' : ` · ${plural(unnamed, 'call')} named no model`}
      </p>
      {finished === null ? null : (
        <p data-finished-only>
          <span className="t-2">Finished runs only</span> {cost(finished, row.currency)} — the
          retried and abandoned runs are in the figure above
        </p>
      )}
    </li>
  );
}

const BUCKETS = [
  ['solo', 'runs used ONE process', 'and make the figures above'],
  ['shared', 'used SEVERAL', 'and is averaged into none'],
  ['unattributed', 'names NO process', 'at all'],
] as const;

function Split(props: { readonly split: AttributionSplitView }): ReactElement {
  const { split } = props;
  const whole = Number(split.total);
  const share = (minor: string): number =>
    whole === 0 ? 0 : Math.round((Number(minor) / whole) * 100);
  return (
    <div className="skc__foot" data-split={split.currency}>
      <p data-split-total>
        Of {cost(split.total, split.currency)} on record, across {plural(split.runs, 'run')}
      </p>
      <ul>
        {BUCKETS.map(([key, said, tail]) => {
          const bucket = split[key];
          return (
            <li key={key} data-bucket={key} data-minor={bucket.total}>
              <strong>{cost(bucket.total, split.currency)}</strong> across {bucket.runs} {said}{' '}
              {tail} ({share(bucket.total)}%)
            </li>
          );
        })}
      </ul>
      {split.unpricedRuns === 0 ? null : (
        <p className="t-2" data-split-unpriced>
          {split.unpricedRuns === 1 ? '1 run has' : `${split.unpricedRuns} runs have`} no known cost
          yet: counted in its bucket, adding nothing to the total.
        </p>
      )}
    </div>
  );
}

function lede(skills: readonly SkillCostView[]): string {
  const thin = skills.filter((row) => row.figure.kind !== 'mean').length;
  const ran = `${skills.length} ${skills.length === 1 ? 'process has' : 'processes have'} run at least once`;
  return thin === 0 ? `${ran}.` : `${ran}, and ${thin} of them not often enough to average.`;
}

export function SkillCostingSection(props: {
  readonly client: OperationsClient;
}): ReactElement | null {
  const { client } = props;
  const [costing, setCosting] = useState<Costing>({ state: 'absent' });
  useEffect(() => {
    void (async () => {
      const answer = await client.read<SkillCostsResult>('finance.skill_costs', {});
      if (isUnavailable(answer)) setCosting({ state: 'not shown', because: answer.because });
      else if (isRefusal(answer) || answer.value.costing === null) setCosting({ state: 'absent' });
      else setCosting({ state: 'shown', costing: answer.value.costing });
    })();
  }, [client]);
  if (costing.state === 'absent') return null;
  return (
    <section id="costing" data-section="009" data-costing>
      <h2>
        009 Skill costing <span className="t-2">Fleet · what a process costs to run</span>
      </h2>
      {costing.state === 'not shown' ? (
        <p>Skill costing could not be read: {costing.because}</p>
      ) : (
        <>
          <p className="skc__lede" data-costing-lede>
            {lede(costing.costing.skills)}
          </p>
          <ul className="skc">
            {costing.costing.skills.map((row) => (
              <SkillRow key={`${row.skillId}:${row.currency}`} row={row} />
            ))}
          </ul>
          {costing.costing.split.map((split) => (
            <Split key={split.currency} split={split} />
          ))}
        </>
      )}
    </section>
  );
}
