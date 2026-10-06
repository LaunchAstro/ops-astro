// SPDX-License-Identifier: AGPL-3.0-only
//
// Connections & signal section 009, skill costing: below the night round and
// above the per-client region. One read, `finance.skill_costs`, draws the
// lede, a row per skill and the attribution foot per currency. It is read as
// the signal sections are: through `useRead`, keyed on the grant and re-read
// on the rollup floor.
//
// The section is not drawn when nothing the caller may see has run, nor for a
// caller the read refuses. A skill's figure has three branches: a mean with its
// spread, one run's figure in words, or a sentence when no run used the skill
// alone; never a zero. Money arrives as minor units in text and is only
// formatted here, never summed. Nothing here acts: the skill name is the door
// to its process document, drawn unavailable with its reason until Docs exists.

import type { ReactElement } from 'react';
import { SectionHead } from '@launchastro/ui';
import type {
  AttributionSplitView,
  SkillCostView,
  SkillCostsResult,
} from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import type { RollupFloor } from '../../data/rollup-floor.ts';
import { useRead } from '../../data/use-read.ts';
import { RecordState } from '../../views/record-state.tsx';
import { money } from '../../views/proposal-record.tsx';
import { plural } from './signal-view.ts';

type Costing = NonNullable<SkillCostsResult['costing']>;

/** The answer's costing, or null when it holds none: an answer without one draws as nothing run. */
const costingOf = (value: SkillCostsResult): Costing | null =>
  Array.isArray(value.costing?.skills) ? value.costing : null;

const cost = (minor: string, currency: string): string => money(Number(minor), currency);
const units = (count: string): string => Number(count).toLocaleString('en-AU');

function Figure(props: { readonly row: SkillCostView }): ReactElement {
  const { figure, currency, usage } = props.row;
  if (figure.kind === 'mean') {
    return (
      <div className="skc__fig" data-figure="mean">
        <span className="skc__figv">
          <span className="skc__n">{cost(figure.mean, currency)}</span>{' '}
          <span className="skc__u">mean</span>
        </span>
        <span className="skc__spread" data-figure-spread>
          {cost(figure.lo, currency)}–{cost(figure.hi, currency)}
        </span>
        {usage.meanIn === null || usage.meanOut === null ? null : (
          <span className="skc__io" data-figure-units>
            <span className="skc__ion">{units(usage.meanIn)}</span>{' '}
            <span className="skc__iok">in</span> ·{' '}
            <span className="skc__ion">{units(usage.meanOut)}</span>{' '}
            <span className="skc__iok">out</span>
          </span>
        )}
      </div>
    );
  }
  if (figure.kind === 'one') {
    return (
      <div className="skc__fig skc__fig--thin" data-figure="one">
        <span className="skc__figv">
          <span className="skc__n">{cost(figure.amount, currency)}</span>{' '}
          <span className="skc__u">one run</span>
        </span>{' '}
        <span className="skc__say">Not an average: this process has run once.</span>
      </div>
    );
  }
  return (
    <div className="skc__fig skc__fig--none" data-figure="none">
      <span className="skc__say">
        No run has used this process on its own, so nothing here can be costed from it.
      </span>
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
      <div className="skc__head">
        <a className="skc__what" data-skill-doc aria-disabled="true" title={row.document.reason}>
          {row.name}
        </a>
      </div>
      <Figure row={row} />
      <p className="skc__obs" data-observed>
        <span className="skc__k">Observed</span> {observed(row)}
      </p>
      <p className="skc__mods" data-models>
        <span className="skc__k">On</span>{' '}
        {row.models.ids.map((id, at) => (
          <span key={id}>
            {at === 0 ? '' : ' '}
            <span className="skc__model">{id}</span>
          </span>
        ))}
        {unnamed === 0 ? '' : ` · ${plural(unnamed, 'call')} named no model`}
      </p>
      {finished === null ? null : (
        <p className="skc__alt" data-finished-only>
          <span className="skc__k">Finished runs only</span> {cost(finished, row.currency)}: the
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
  // A whole percent of the total, in integers: the money itself is never summed here.
  const whole = BigInt(split.total);
  const share = (minor: string): string =>
    whole === 0n ? '0' : String((BigInt(minor) * 200n + whole) / (2n * whole));
  return (
    <div className="skc__foot" data-split={split.currency}>
      <p className="skc__split">
        <span className="skc__k" data-split-total>
          Of {cost(split.total, split.currency)} on record, across {plural(split.runs, 'run')}
        </span>
        {BUCKETS.map(([key, said, tail]) => {
          const bucket = split[key];
          return (
            <span className="skc__leg" key={key} data-bucket={key} data-minor={bucket.total}>
              <b>{cost(bucket.total, split.currency)}</b> across {bucket.runs} {said} {tail} (
              {share(bucket.total)}%)
            </span>
          );
        })}
      </p>
      {split.unpricedRuns === 0 ? null : (
        <p className="approval__meta" data-split-unpriced>
          {split.unpricedRuns === 1 ? '1 run has' : `${split.unpricedRuns} runs have`} no known cost
          yet: counted in its bucket, adding nothing to the total.
        </p>
      )}
    </div>
  );
}

function Shown(props: { readonly costing: Costing }): ReactElement {
  const { skills, split } = props.costing;
  return (
    <>
      <div className="skc__lede">
        <p className="skc__count" data-costing-lede>
          {lede(skills)}
        </p>
      </div>
      <div className="card card--flush">
        <ul className="skc">
          {skills.map((row) => (
            <SkillRow key={`${row.skillId}:${row.currency}`} row={row} />
          ))}
        </ul>
      </div>
      {split.map((one) => (
        <Split key={one.currency} split={one} />
      ))}
    </>
  );
}

function lede(skills: readonly SkillCostView[]): string {
  const thin = skills.filter((row) => row.figure.kind !== 'mean').length;
  const ran = `${skills.length} ${skills.length === 1 ? 'process has' : 'processes have'} run at least once`;
  return thin === 0 ? `${ran}.` : `${ran}, and ${thin} of them not often enough to average.`;
}

export function SkillCostingSection(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly rollup?: RollupFloor;
}): ReactElement | null {
  const { client } = props;
  const { state, reload } = useRead<SkillCostsResult>({
    grantKey: props.grantKey,
    run: () => client.read<SkillCostsResult>('finance.skill_costs', {}),
    isEmpty: (value) => costingOf(value) === null,
    ...(props.rollup === undefined ? {} : { rollup: props.rollup }),
    deps: [],
  });
  // Nothing has run, or the caller may not see costs: the section is absent.
  if (state.outcome === 'empty' || state.outcome === 'denied') return null;
  if (
    state.outcome === 'loading' &&
    (state.previous === null || costingOf(state.previous) === null)
  )
    return null;
  return (
    <section id="costing" className="skcsec" data-section="009" data-costing>
      <SectionHead index="009" title="Skill costing" right="Fleet · what a process costs to run" />
      <RecordState state={state} subject="skill costing" onRetry={reload} keep>
        {(value) => {
          const costing = costingOf(value);
          return costing === null ? null : <Shown costing={costing} />;
        }}
      </RecordState>
    </section>
  );
}
