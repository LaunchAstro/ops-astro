// SPDX-License-Identifier: AGPL-3.0-only
//
// The execution map on the task page's Agent perspective (MP-6-3, TA-02,
// TG-03 to TG-09): the bound plan's steps by depth, each card beside what its
// runs did, Rail lines between them, and one step in the inspector under it.
//
// Read-only: a card is a button that selects, never a handle that edits, and
// the reading line says "not editable" once (D-19). The connector style is
// Rail, drawn for reference only (R63): no study bar, no route facets. At 900
// and below the canvas becomes a vertical list with each card's dependency in
// words, from the same DOM (CSS only), so the two never disagree.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Empty } from '../../primitives/Absence.tsx';
import { Spill } from '../../primitives/Status.tsx';
import {
  executionMap,
  GEO,
  type ExecutionMapView,
  type MapGate,
  type MapGraph,
  type MapStep,
} from '../../state/execution-map.ts';
import { MapInspector } from './execution-inspector.tsx';

export interface ExecutionMapProps {
  readonly graph: MapGraph;
  readonly gates: readonly MapGate[];
}

type Bound = Extract<ExecutionMapView, { readonly kind: 'bound' }>;

const NO_RUN = 'No agent run on this task yet, so there is nothing to draw.';
const UNBOUND =
  'This task’s runs have no bound plan, so the map is not drawn. Nothing is hidden: the runs are listed under “The run”.';

export function ExecutionMap(props: ExecutionMapProps): ReactElement {
  const view = executionMap(props.graph, props.gates);
  const reading =
    view.kind === 'bound' ? 'plan: bound · derived layout · not editable' : 'plan: unbound';
  return (
    <section className="sb__sect" data-execution-map={view.kind} aria-label="Execution map">
      <div className="sb__sh">
        <span className="sb__k">Execution map</span>
        <span className="sb__meta" data-map="reading">
          {reading}
        </span>
      </div>
      {view.kind === 'no-run' ? (
        <Empty look="inline" title={NO_RUN} />
      ) : view.kind === 'unbound' ? (
        <Empty look="inline" title={UNBOUND} />
      ) : (
        <Canvas view={view} />
      )}
    </section>
  );
}

function Canvas({ view }: { readonly view: Bound }): ReactElement {
  const [selected, setSelected] = useState<string | null>(view.preselect);
  const scroll = useRef<HTMLDivElement>(null);
  const chosen = view.steps.find((step) => step.key === selected) ?? null;
  // D-15: the preselected step is brought into the scroll box, never left off to the side.
  const x = chosen?.x ?? null;
  useEffect(() => {
    const box = scroll.current;
    if (box === null || x === null) return;
    const left = x + GEO.nodeW / 2 - box.clientWidth / 2;
    box.scrollLeft = Math.max(0, Math.min(left, view.width - box.clientWidth));
  }, [x, view.width]);
  return (
    <div className="tg">
      <Legend />
      <div className="tg__scroll" ref={scroll} data-map="scroll">
        <div
          className="tg__canvas"
          data-route="rail"
          style={{
            ['--tg-w' as string]: `${String(view.width)}px`,
            ['--tg-h' as string]: `${String(view.height)}px`,
          }}
        >
          <Stages count={view.stages} />
          <Lines view={view} />
          {view.steps.map((step) => (
            <Card
              key={step.key}
              step={step}
              pressed={step.key === selected}
              onSelect={() => {
                setSelected((now) => (now === step.key ? null : step.key));
              }}
            />
          ))}
        </div>
      </div>
      <MapInspector step={chosen} />
      {view.orphans.length === 0 ? null : (
        <div className="tg__orphan" data-map="orphans">
          <Empty
            look="inline"
            title={`${String(view.orphans.length)} ${view.orphans.length === 1 ? 'run sits' : 'runs sit'} outside the bound plan, so the map does not place ${view.orphans.length === 1 ? 'it' : 'them'}. Each is listed under “The run”.`}
          />
        </div>
      )}
    </div>
  );
}

/** TG-03: the two line samples. "Not editable" is the reading line's alone (D-19). */
function Legend(): ReactElement {
  return (
    <div className="tg__bar">
      <div className="tg__legend">
        <span className="sb__k">
          <i className="tg__lline" aria-hidden="true" />
          Dependency
        </span>
        <span className="sb__k">
          <i className="tg__lline tg__lline--wait" aria-hidden="true" />
          Blocked
        </span>
      </div>
    </div>
  );
}

function Stages({ count }: { readonly count: number }): ReactElement {
  return (
    <>
      {Array.from({ length: count }, (_, col) => (
        <span
          className="tg__stage sb__k"
          key={col}
          style={{
            left: `${String(GEO.padX + col * (GEO.nodeW + GEO.colGap))}px`,
            top: `${String(GEO.padTop)}px`,
            width: `${String(GEO.nodeW)}px`,
            height: `${String(GEO.stageH)}px`,
          }}
        >
          Depth {col + 1}
        </span>
      ))}
    </>
  );
}

function Lines({ view }: { readonly view: Bound }): ReactElement {
  return (
    <svg
      className="tg__edges"
      viewBox={`0 0 ${String(view.width)} ${String(view.height)}`}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <marker id="tg-a" markerWidth="7" markerHeight="7" refX="6.2" refY="3.5" orient="auto">
          <path className="tg__arrow" d="M0,0 L7,3.5 L0,7 Z" />
        </marker>
        <marker id="tg-aw" markerWidth="7" markerHeight="7" refX="6.2" refY="3.5" orient="auto">
          <path className="tg__arrow tg__arrow--wait" d="M0,0 L7,3.5 L0,7 Z" />
        </marker>
      </defs>
      {view.paths.map((path) => (
        <path
          className={path.wait ? 'tg__edge tg__edge--wait' : 'tg__edge'}
          d={path.d}
          data-edge={path.wait ? 'wait' : 'satisfied'}
          key={path.d}
          markerEnd={path.stub ? undefined : `url(#${path.wait ? 'tg-aw' : 'tg-a'})`}
        />
      ))}
      {view.joins.map((join) => (
        <circle
          className="tg__join"
          cx={join.x}
          cy={join.y}
          key={`${String(join.x)}|${String(join.y)}`}
          r="3.5"
        />
      ))}
    </svg>
  );
}

function Card(props: {
  readonly step: MapStep;
  readonly pressed: boolean;
  readonly onSelect: () => void;
}): ReactElement {
  const { step } = props;
  const newest = step.runs.at(-1);
  const owner =
    step.runs.length === 0
      ? 'No run yet'
      : `${String(step.runs.length)} ${step.runs.length === 1 ? 'run' : 'runs'}${
          newest?.observed.whoseMove === null || newest === undefined
            ? ''
            : ` · ${newest.observed.whoseMove.kind === 'agent' ? 'the agent’s move' : 'a person’s move'}`
        }`;
  return (
    <button
      className="tg__node"
      type="button"
      data-tg-node={step.key}
      data-kind={step.terminal ? 'terminal' : 'job'}
      data-tone={step.state.tone}
      aria-pressed={props.pressed}
      onClick={props.onSelect}
      style={{ left: `${String(step.x)}px`, top: `${String(step.y)}px` }}
    >
      <span className="tg__ntop">
        <span className="sb__k tg__nkey">{step.key}</span>
        <span className="tg__nstate">
          <Spill state={{ ...step.state, reference: 'new_behaviour' }} />
        </span>
      </span>
      <span className="tg__nmain">
        <span className="tg__nt">{step.title}</span>
        <span className="tg__nowner sb__k">{owner}</span>
        <span className="tg__nout sb__k">
          <b>{step.out.k}</b> {step.out.v}
        </span>
      </span>
      <span className="tg__ndep sb__k" data-map="dependency">
        {step.sentence}
      </span>
    </button>
  );
}
