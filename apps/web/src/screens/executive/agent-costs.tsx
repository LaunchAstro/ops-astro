// SPDX-License-Identifier: AGPL-3.0-only
//
// Executive section 005, what our agents cost us (MP-14-6, CS-14.10; mockup
// `/agency/executive/` #agentcost). One read, `finance.agent_costs`, for the
// last thirty days, through `useRead` keyed on the grant and re-read on the
// rollup floor: the tiles, the cost log and the two roll-ups beside it are all
// drawn from its answer, so they cannot disagree. The log has a row per run,
// agent and currency, so the tiles count distinct runs and agents. Every amount
// is the server's, minor units in text: the page formats them and adds none
// up, so it has no grand total of its own.
//
// Internal only: it is cost to us, never an amount a client is billed, and the
// section says so in its own markup (`data-view="agency"`). A run with no
// known cost says so and is never a zero; a run that belongs to no client is
// the agency's. The log folds at 8 rows, as the book does.

import { useState, type ReactElement, type ReactNode } from 'react';
import { Card, Empty, Meter, SectionHead, Stat, StatRow, Table } from '@launchastro/ui';
import type {
  AgentCostRowView,
  AgentCostsResult,
  CostAttachment,
} from '../../../../../packages/core-wire/src/index.ts';
import type { OperationsClient } from '../../operations/client.ts';
import type { RollupFloor } from '../../data/rollup-floor.ts';
import { useRead } from '../../data/use-read.ts';
import { RecordState } from '../../views/record-state.tsx';
import { money } from '../../views/proposal-record.tsx';

const DAY = 86_400_000;
const FOLD = 8;
const TIP =
  'What our own agent runs cost, priced at list API rates. Internal only: this is cost to us, not anything a client is charged.';

const cost = (minor: string, currency: string): string => money(Number(minor), currency);
const day = (at: string): string =>
  new Date(at).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
const agentName = (id: string | null): string =>
  id === null ? 'An unnamed agent' : `Agent ${id.slice(0, 8)}`;
const plural = (count: number, word: string): string =>
  `${String(count)} ${word}${count === 1 ? '' : 's'}`;
const distinct = (
  rows: readonly AgentCostRowView[],
  of: (row: AgentCostRowView) => unknown,
): number => new Set(rows.map((row) => of(row))).size;
const runCount = (costs: AgentCostsResult): number => distinct(costs.runs, (row) => row.runId);

function Who(props: { readonly attachment: CostAttachment }): ReactElement {
  const { attachment } = props;
  return attachment.kind === 'agency' ? (
    <span className="marker" data-cost-who>
      the agency
    </span>
  ) : (
    <span data-cost-who>{attachment.name ?? 'A client'}</span>
  );
}

function Spend(props: { readonly row: AgentCostRowView }): ReactElement {
  const { row } = props;
  return row.cost === null ? (
    <span className="t-2" data-cost-unpriced title={row.unpriced ?? undefined}>
      no price yet
    </span>
  ) : (
    <span className="num">{cost(row.cost, row.currency)}</span>
  );
}

function Models(props: { readonly row: AgentCostRowView }): ReactElement {
  const { ids, unnamedCalls } = props.row.models;
  return (
    <>
      {ids.map((id) => (
        <span key={id} className="skc__model">
          {id}
        </span>
      ))}
      {unnamedCalls === 0 ? null : (
        <span className="t-2"> {plural(unnamedCalls, 'call')} named no model</span>
      )}
    </>
  );
}

const COLUMNS = [
  { key: 'when', label: 'Started' },
  { key: 'model', label: 'Model' },
  { key: 'cost', label: 'Cost to us', align: 'end' },
  { key: 'who', label: 'Attached to' },
  { key: 'agent', label: 'Agent' },
] as const;

function logRow(row: AgentCostRowView): Readonly<Record<string, ReactNode>> {
  return {
    when: (
      <span className="t-2" data-cost-run={row.runId}>
        {day(row.startedAt)}
      </span>
    ),
    model: <Models row={row} />,
    cost: <Spend row={row} />,
    who: <Who attachment={row.attachment} />,
    agent: agentName(row.agentActorId),
  };
}

/** One roll-up line: its label, its spend against the largest line in its currency, and its runs. */
function Bar(props: {
  readonly label: ReactNode;
  readonly total: string;
  readonly of: number;
  readonly currency: string;
  readonly runs: number;
  readonly unpriced: number;
  readonly mark: Readonly<Record<string, string>>;
}): ReactElement {
  return (
    <div {...props.mark}>
      <div className="spread">
        <span className="t-sm">{props.label}</span>
        <span className="num">{cost(props.total, props.currency)}</span>
      </div>
      <Meter
        label={`${props.currency} against the largest`}
        value={Number(props.total)}
        max={props.of}
      />
      <p className="t-2">
        {plural(props.runs, 'run')}
        {props.unpriced === 0 ? '' : ` · ${String(props.unpriced)} with no price yet`}
      </p>
    </div>
  );
}

type Line = AgentCostsResult['byAgent'][number] | AgentCostsResult['byAttachment'][number];

/** Each currency's largest line: a meter's end, compared and never summed. */
function largestOf(lines: readonly Line[]): ReadonlyMap<string, number> {
  const largest = new Map<string, number>();
  for (const line of lines) {
    largest.set(line.currency, Math.max(largest.get(line.currency) ?? 0, Number(line.total)));
  }
  return largest;
}

function Tiles(props: { readonly costs: AgentCostsResult }): ReactElement {
  const { costs } = props;
  const unpriced = distinct(
    costs.runs.filter((row) => row.cost === null),
    (row) => row.runId,
  );
  return (
    <StatRow columns={3}>
      <div data-cost-kpi="runs">
        <Stat label="Runs" term={TIP} value={runCount(costs)} />
      </div>
      <div data-cost-kpi="unpriced">
        <Stat label="With no price yet" value={unpriced} />
      </div>
      <div data-cost-kpi="agents">
        <Stat label="Agents" value={distinct(costs.runs, (row) => row.agentActorId)} />
      </div>
    </StatRow>
  );
}

function Log(props: { readonly runs: readonly AgentCostRowView[] }): ReactElement {
  const { runs } = props;
  const [open, setOpen] = useState(false);
  const rows = open ? runs : runs.slice(0, FOLD);
  return (
    <Card flush>
      <Table caption="The cost log" columns={COLUMNS} rows={rows.map((row) => logRow(row))} dense />
      {open || runs.length <= FOLD ? null : (
        <button
          type="button"
          className="btn btn--ghost"
          data-cost-more
          onClick={() => setOpen(true)}
        >
          Show {String(runs.length - FOLD)} more
        </button>
      )}
    </Card>
  );
}

const attachedKey = (attachment: CostAttachment): string =>
  attachment.kind === 'client' ? attachment.id : 'agency';

function RollUps(props: { readonly costs: AgentCostsResult }): ReactElement {
  const { costs } = props;
  const byAgent = largestOf(costs.byAgent);
  const byAttachment = largestOf(costs.byAttachment);
  return (
    <div className="stack">
      <Card title="By agent" sub="Each agent's runs in the period">
        {costs.byAgent.map((line) => (
          <Bar
            key={`${String(line.agentActorId)}:${line.currency}`}
            label={agentName(line.agentActorId)}
            total={line.total}
            of={byAgent.get(line.currency) ?? 0}
            currency={line.currency}
            runs={line.runs}
            unpriced={line.unpricedRuns}
            mark={{ 'data-cost-agent': String(line.agentActorId) }}
          />
        ))}
      </Card>
      <Card
        title="By what it was attached to"
        sub="A task's client, or the agency when it has none"
      >
        {costs.byAttachment.map((line) => (
          <Bar
            key={`${attachedKey(line.attachment)}:${line.currency}`}
            label={<Who attachment={line.attachment} />}
            total={line.total}
            of={byAttachment.get(line.currency) ?? 0}
            currency={line.currency}
            runs={line.runs}
            unpriced={line.unpricedRuns}
            mark={{ 'data-cost-attached': attachedKey(line.attachment) }}
          />
        ))}
      </Card>
    </div>
  );
}

function Shown(props: { readonly costs: AgentCostsResult }): ReactElement {
  const { costs } = props;
  return (
    <>
      <p className="t-2" data-cost-period>
        {day(costs.period.from)} to {day(costs.period.to)}
      </p>
      {costs.runs.length === 0 ? (
        <Empty look="inline" title="No agent ran in this period." />
      ) : (
        <>
          <Tiles costs={costs} />
          <div className="agentcost__grid">
            <Log runs={costs.runs} />
            <RollUps costs={costs} />
          </div>
        </>
      )}
    </>
  );
}

export function AgentCostSection(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly now: () => number;
  readonly rollup?: RollupFloor;
}): ReactElement | null {
  const { client } = props;
  // The period is fixed when the section opens: the last thirty days to then.
  const [period] = useState(() => {
    const to = props.now();
    return { from: new Date(to - 30 * DAY).toISOString(), to: new Date(to).toISOString() };
  });
  const { state, reload } = useRead<AgentCostsResult>({
    grantKey: props.grantKey,
    run: () => client.read<AgentCostsResult>('finance.agent_costs', period),
    ...(props.rollup === undefined ? {} : { rollup: props.rollup }),
    deps: [],
  });
  // A caller who may not see costs is shown no section at all.
  if (state.outcome === 'denied') return null;
  const shown = state.outcome === 'ready' ? state.value : null;
  return (
    <section className="secs" id="agentcost" data-section="005" data-view="agency" data-agent-costs>
      <SectionHead
        index="005"
        title="What our agents cost us"
        right={`${shown === null ? 'Runs' : plural(runCount(shown), 'run')} · API-equivalent`}
      />
      <RecordState state={state} subject="agent costs" onRetry={reload}>
        {(costs) => <Shown costs={costs} />}
      </RecordState>
    </section>
  );
}
