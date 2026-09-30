// SPDX-License-Identifier: AGPL-3.0-only
//
// The board machine's command bar (U09 and U13, MP-5-7, DS-COMP-16): search,
// the funnel menu of every filter, Reset columns, undo, redo, Clear all and
// the freshness stamp. Every press is a view change sent to the machine; the
// menu's open state, its find text and Show all are the menu's own.

import type { ReactElement } from 'react';
import { FUNNEL_FIRST, freshness, funnelMenu, hiddenFilters } from '../board/funnel.ts';
import type { RankedFacet } from '../board/funnel.ts';
import type { BoardAction, Facet, MachineState, Preset } from '../board/types.ts';
import { BoardSearch } from './BoardSearch.tsx';
import { STACK_TIP } from './board-props.ts';
import type { useFunnelMenu } from './board-hooks.ts';

type Send = (action: BoardAction) => void;
type Menu = ReturnType<typeof useFunnelMenu>;

export function CommandBar<Row>(props: {
  readonly facets: readonly Facet<Row>[];
  readonly names: readonly string[];
  readonly noun: string;
  readonly machine: MachineState;
  readonly ranked: readonly RankedFacet[];
  readonly presets: readonly Preset[];
  readonly menu: Menu;
  readonly changedAt: string | null;
  readonly now: Date;
  readonly dispatch: Send;
}): ReactElement {
  const { dispatch } = props;
  const view = props.machine.view;
  return (
    <div className="cbd__cmd">
      <BoardSearch
        facets={props.facets}
        names={props.names}
        noun={props.noun}
        have={view}
        onCommit={(raw) => {
          dispatch({ type: 'commit', raw });
        }}
        onTake={(item) => {
          if (item.facetId !== undefined) dispatch({ type: 'take', facetId: item.facetId });
          else if (item.text !== undefined) dispatch({ type: 'phrase', text: item.text });
        }}
        onDropLast={() => {
          dispatch({ type: 'dropLast' });
        }}
      />
      <Funnel
        menu={props.menu}
        ranked={props.ranked}
        hidden={hiddenFilters(view, props.presets)}
        ids={view.ids}
        noun={props.noun}
        dispatch={dispatch}
      />
      <Steps machine={props.machine} dispatch={dispatch} />
      <Stamp changedAt={props.changedAt} now={props.now} />
    </div>
  );
}

interface FunnelProps {
  readonly menu: Menu;
  readonly ranked: readonly RankedFacet[];
  /** How many filters are on that the chip row does not show. */
  readonly hidden: number;
  readonly ids: readonly string[];
  readonly noun: string;
  readonly dispatch: Send;
}

function Funnel(props: FunnelProps): ReactElement {
  const { menu, setMenu, funnel, wrap } = props.menu;
  const { hidden } = props;
  const label =
    hidden === 0 ? 'Filters' : `Filters, ${String(hidden)} on that this bar does not show`;
  return (
    <div
      className="cbd__funnelw"
      ref={wrap}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !menu.open) return;
        event.stopPropagation();
        setMenu((current) => ({ ...current, open: false }));
        funnel.current?.focus();
      }}
    >
      <button
        className={`cbd__ico cbd__funnel${menu.open ? ' is-on' : ''}`}
        data-funnel=""
        type="button"
        ref={funnel}
        aria-expanded={menu.open}
        aria-controls="cbd-menu"
        aria-label={label}
        title={label}
        onClick={() => {
          setMenu((current) => ({ ...current, open: !current.open }));
        }}
      >
        ⏷
        {hidden === 0 ? null : (
          <span className="cbd__badge" data-badge="" aria-hidden="true">
            {hidden}
          </span>
        )}
      </button>
      <FunnelList {...props} />
    </div>
  );
}

function FunnelList(props: FunnelProps): ReactElement {
  const { menu, setMenu, find } = props.menu;
  const listing = funnelMenu(props.ranked, menu.q, menu.all);
  return (
    <div className="cbd__menu" id="cbd-menu" role="group" aria-label="Filters" hidden={!menu.open}>
      <div className="cbd__menuhd">
        <span className="cbd__flabel">Filters</span>
      </div>
      <label className="cbd__menuq">
        <input
          id="cbd-menu-q"
          ref={find}
          type="text"
          placeholder="Find a filter…"
          autoComplete="off"
          aria-label="Find a filter by name"
          value={menu.q}
          onChange={(event) => {
            const q = event.target.value;
            setMenu((current) => ({ ...current, q }));
          }}
        />
      </label>
      <FacetGroups listing={listing} ids={props.ids} noun={props.noun} dispatch={props.dispatch} />
      {listing.shown === 0 && menu.q.trim() !== '' ? (
        <p className="cbd__menuempty">No filter matches “{menu.q.trim()}”.</p>
      ) : null}
      {listing.more > 0 || (menu.all && listing.shown > FUNNEL_FIRST) ? (
        <button
          className="cbd__lnk"
          type="button"
          data-showall=""
          aria-expanded={menu.all}
          onClick={() => {
            setMenu((current) => ({ ...current, all: !current.all }));
          }}
        >
          {menu.all ? 'Show fewer filters' : `Show all filters (${String(listing.more)} more)`}
        </button>
      ) : null}
    </div>
  );
}

function FacetGroups(props: {
  readonly listing: ReturnType<typeof funnelMenu>;
  readonly ids: readonly string[];
  readonly noun: string;
  readonly dispatch: Send;
}): ReactElement {
  return (
    <>
      {props.listing.groups.map((group) => (
        <div className="cbd__menugrp" key={group.kind}>
          <span className="cbd__menuk">{group.kind}</span>
          {group.facets.map((one) => (
            <button
              className="cbd__facet"
              key={one.id}
              type="button"
              data-add={one.id}
              data-count={one.count}
              aria-pressed={props.ids.includes(one.id)}
              title={`${String(one.count)} ${props.noun}s${STACK_TIP}`}
              onClick={(event) => {
                props.dispatch({ type: 'press', id: one.id, stack: event.shiftKey });
              }}
            >
              {one.label}
            </button>
          ))}
        </div>
      ))}
    </>
  );
}

/** Reset columns (only once a width is the person's own), undo, redo and Clear all. */
function Steps(props: { readonly machine: MachineState; readonly dispatch: Send }): ReactElement {
  const { view, history } = props.machine;
  const { dispatch } = props;
  const rest = view.ids.length === 0 && view.text.length === 0;
  return (
    <>
      {view.widths === null ? null : (
        <button
          className="cbd__ico"
          data-reset=""
          type="button"
          title="Reset columns"
          aria-label="Reset columns"
          onClick={() => {
            dispatch({ type: 'resetWidths' });
          }}
        >
          ↔
        </button>
      )}
      <Step kind="undo" step={history.past.at(-1)} dispatch={dispatch} />
      <Step kind="redo" step={history.future.at(-1)} dispatch={dispatch} />
      <button
        className="btn btn--primary btn--sm cbd__clear"
        type="button"
        disabled={rest}
        title={rest ? 'Nothing to clear' : 'Drop every filter and search term'}
        onClick={() => {
          dispatch({ type: 'clear' });
        }}
      >
        Clear all
      </button>
    </>
  );
}

function Step(props: {
  readonly kind: 'undo' | 'redo';
  readonly step: { readonly label: string } | undefined;
  readonly dispatch: Send;
}): ReactElement {
  const { kind, step } = props;
  const title =
    step === undefined
      ? `Nothing to ${kind}`
      : `${kind === 'undo' ? 'Undo' : 'Redo'} ${step.label}`;
  return (
    <button
      className="cbd__ico"
      {...(kind === 'undo' ? { 'data-undo': '' } : { 'data-redo': '' })}
      type="button"
      disabled={step === undefined}
      title={title}
      aria-label={title}
      onClick={() => {
        props.dispatch({ type: kind });
      }}
    >
      {kind === 'undo' ? '↶' : '↷'}
    </button>
  );
}

/** When the newest record in scope changed (MP-5-7, P-07); nothing without a time. */
function Stamp(props: {
  readonly changedAt: string | null;
  readonly now: Date;
}): ReactElement | null {
  const stamp = freshness(props.changedAt, props.now);
  if (stamp === null) return null;
  return (
    <span className="cbd__fresh" data-freshness="" title={props.changedAt ?? undefined}>
      <span className="cbd__freshl">{stamp.long}</span>
      <span className="cbd__freshs" aria-hidden="true">
        {stamp.short}
      </span>
    </span>
  );
}
