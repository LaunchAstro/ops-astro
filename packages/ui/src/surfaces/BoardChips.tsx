// SPDX-License-Identifier: AGPL-3.0-only
//
// The board machine's chip row (U09, DS-COMP-16): the presets, the modes with
// their live counts, and a tag for every filter or phrase the presets on
// cannot show, each tag dropping its own. Every press is a view change sent
// to the machine; nothing here writes a record.

import type { ReactElement, RefObject } from 'react';
import { presetCount } from '../board/filters.ts';
import type { BoardAction, BoardView, Facet, Preset } from '../board/types.ts';
import { GLYPH, STACK_TIP, type BoardMode } from './board-props.ts';

export function ChipRow<Row>(props: {
  readonly chipRow: RefObject<HTMLDivElement | null>;
  readonly rows: readonly Row[];
  readonly presets: readonly Preset[];
  readonly modes: readonly BoardMode<Row>[];
  readonly facets: readonly Facet<Row>[];
  readonly hay: (row: Row) => string;
  readonly view: BoardView;
  readonly dispatch: (action: BoardAction) => void;
}): ReactElement {
  const { view, dispatch } = props;
  const onPresets = onPresetsOf(props.presets, view);
  const shownByPreset = new Set(onPresets.flatMap((preset) => preset.facetIds));
  return (
    <div className="cbd__filters" ref={props.chipRow}>
      {props.presets.map((preset) => (
        <PresetChip
          key={preset.id}
          preset={preset}
          on={onPresets.includes(preset)}
          count={presetCount(props.rows, preset, props.facets, props.hay)}
          onPress={(stack) => {
            dispatch({ type: 'preset', id: preset.id, stack });
          }}
        />
      ))}
      {props.modes.map((one) => (
        <ModeChip key={one.id} mode={one} on={view.mode === one.id} dispatch={dispatch} />
      ))}
      <FilterTags facets={props.facets} view={view} hidden={shownByPreset} dispatch={dispatch} />
    </div>
  );
}

/** A tag for every filter the presets on cannot show, then every phrase. */
function FilterTags<Row>(props: {
  readonly facets: readonly Facet<Row>[];
  readonly view: BoardView;
  readonly hidden: ReadonlySet<string>;
  readonly dispatch: (action: BoardAction) => void;
}): ReactElement {
  const { view, dispatch } = props;
  return (
    <>
      {view.ids
        .filter((id) => !props.hidden.has(id))
        .map((id) => props.facets.find((facet) => facet.id === id))
        .map((facet) =>
          facet === undefined ? null : (
            <Tag
              key={facet.id}
              kind={facet.kind}
              label={facet.label}
              onDrop={() => {
                dispatch({ type: 'drop', id: facet.id });
              }}
            />
          ),
        )}
      {view.text.map((term) => (
        <Tag
          key={`text:${term}`}
          kind="Text"
          label={term}
          onDrop={() => {
            dispatch({ type: 'dropText', text: term });
          }}
        />
      ))}
    </>
  );
}

/** The presets whose every filter is on. */
function onPresetsOf(presets: readonly Preset[], view: BoardView): readonly Preset[] {
  return presets.filter(
    (preset) => preset.facetIds.length > 0 && preset.facetIds.every((id) => view.ids.includes(id)),
  );
}

function ModeChip<Row>(props: {
  readonly mode: BoardMode<Row>;
  readonly on: boolean;
  readonly dispatch: (action: BoardAction) => void;
}): ReactElement {
  const { mode } = props;
  return (
    <button
      className={`cbd__mode${props.on ? ' is-on' : ''}`}
      data-mode={mode.id}
      type="button"
      aria-pressed={props.on}
      {...(mode.badge === undefined ? {} : { title: mode.badge.title })}
      onClick={() => {
        props.dispatch({ type: 'mode', id: mode.id });
      }}
    >
      {mode.label}
      {mode.badge === undefined ? null : (
        <span className="cbd__count cbd__count--accent">{mode.badge.count}</span>
      )}
    </button>
  );
}

function PresetChip(props: {
  readonly preset: Preset;
  readonly on: boolean;
  readonly count: number;
  readonly onPress: (stack: boolean) => void;
}): ReactElement {
  const variant = props.preset.variant === undefined ? '' : ` cbd__preset--${props.preset.variant}`;
  // A flag, never a count (P-13): the chip says why in its title.
  const flag = props.preset.flag;
  return (
    <button
      className={`cbd__preset${variant}${props.on ? ' is-on' : ''}${flag === undefined ? '' : ' is-flagged'}`}
      data-preset={props.preset.id}
      type="button"
      aria-pressed={props.on}
      aria-label={props.preset.label}
      title={`${props.preset.label}${flag === undefined ? '' : ` · ${flag}`}${STACK_TIP}`}
      onClick={(event) => {
        props.onPress(event.shiftKey);
      }}
    >
      <span className="cbd__presi" data-icon={props.preset.icon} aria-hidden="true">
        {GLYPH[props.preset.icon ?? ''] ?? props.preset.label.charAt(0)}
      </span>
      <span className="cbd__presetw">{props.preset.label}</span>
      {props.preset.uncounted === true ? null : <span className="cbd__count">{props.count}</span>}
    </button>
  );
}

function Tag(props: {
  readonly kind: string;
  readonly label: string;
  readonly onDrop: () => void;
}): ReactElement {
  return (
    <span className="cbd__tag">
      <span className="cbd__tagk">{props.kind}</span>
      {props.label}
      <button
        className="cbd__tagx"
        type="button"
        aria-label={`Remove ${props.label}`}
        onClick={props.onDrop}
      >
        ×
      </button>
    </span>
  );
}
