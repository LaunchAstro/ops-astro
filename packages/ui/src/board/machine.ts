// SPDX-License-Identifier: AGPL-3.0-only
//
// The board's view state and its history (MP-5-3, MP-5-4, B-12, CS-5.5).
//
// Every change a person makes to how the board reads (a filter, a search, a
// sort, a mode, a column width) goes through `reduceBoard`, which records the
// view it replaced under a label naming the step, so Undo can say what it
// would undo. Sixty steps are kept. The history holds views only: nothing
// here writes a record, and undoing a view change never touches one.
//
// A press on something the board does not offer (an unknown facet, preset,
// mode or column) changes nothing and records nothing.

import { nextSort } from './sort.ts';
import { parseQuery, pressFacet } from './filters.ts';
import type { BoardAction, BoardContext, BoardView, MachineState } from './types.ts';

export const HISTORY_CAP = 60;

const REST: BoardView = { ids: [], text: [], sort: null, mode: null, widths: null };

export function initialMachine(view: BoardView = REST): MachineState {
  return { view, history: { past: [], future: [] } };
}

function record(state: MachineState, label: string, view: BoardView): MachineState {
  return {
    view,
    history: {
      past: [...state.history.past, { label, view: state.view }].slice(-HISTORY_CAP),
      future: [],
    },
  };
}

const unique = (list: readonly string[]): readonly string[] => [...new Set(list)];

export function reduceBoard<Row>(
  state: MachineState,
  action: BoardAction,
  context: BoardContext<Row>,
): MachineState {
  const view = state.view;
  const facetLabel = (id: string): string | undefined =>
    context.facets.find((facet) => facet.id === id)?.label;

  switch (action.type) {
    case 'press':
    case 'take': {
      const id = action.type === 'press' ? action.id : action.facetId;
      const label = facetLabel(id);
      if (label === undefined) return state;
      const ids =
        action.type === 'press'
          ? pressFacet(view.ids, id, action.stack)
          : unique([...view.ids, id]);
      return record(state, `filter ${label}`, { ...view, ids });
    }
    case 'preset': {
      const preset = context.presets.find((one) => one.id === action.id);
      if (preset === undefined) return state;
      const on = preset.facetIds.every((id) => view.ids.includes(id));
      let ids: readonly string[];
      if (action.stack) {
        ids = on
          ? view.ids.filter((id) => !preset.facetIds.includes(id))
          : unique([...view.ids, ...preset.facetIds]);
      } else {
        ids = on && view.ids.length === preset.facetIds.length ? [] : [...preset.facetIds];
      }
      return record(state, `filter ${preset.label}`, { ...view, ids });
    }
    case 'mode': {
      const mode = context.modes.find((one) => one.id === action.id);
      if (mode === undefined) return state;
      return record(state, `mode ${mode.label}`, {
        ...view,
        mode: view.mode === mode.id ? null : mode.id,
      });
    }
    case 'drop': {
      if (!view.ids.includes(action.id)) return state;
      return record(state, `drop ${facetLabel(action.id) ?? 'filter'}`, {
        ...view,
        ids: view.ids.filter((id) => id !== action.id),
      });
    }
    case 'dropText': {
      if (!view.text.includes(action.text)) return state;
      return record(state, `drop “${action.text}”`, {
        ...view,
        text: view.text.filter((term) => term !== action.text),
      });
    }
    case 'dropLast': {
      const lastText = view.text.at(-1);
      if (lastText !== undefined)
        return reduceBoard(state, { type: 'dropText', text: lastText }, context);
      const lastId = view.ids.at(-1);
      if (lastId !== undefined) return reduceBoard(state, { type: 'drop', id: lastId }, context);
      return state;
    }
    case 'clear': {
      if (view.ids.length === 0 && view.text.length === 0) return state;
      return record(state, 'clear all', { ...view, ids: [], text: [] });
    }
    case 'commit': {
      const parsed = parseQuery(action.raw, context.facets);
      if (parsed.ids.length === 0 && parsed.text.length === 0) return state;
      const words = [
        ...parsed.ids.map((id) => facetLabel(id) ?? id),
        ...parsed.text.map((term) => `“${term}”`),
      ];
      return record(state, `search ${words.join(' + ')}`, {
        ...view,
        ids: unique([...view.ids, ...parsed.ids]),
        text: unique([...view.text, ...parsed.text]),
      });
    }
    case 'phrase': {
      const words = action.text
        .toLowerCase()
        .split(/\s+/u)
        .filter((word) => word !== '');
      if (words.length === 0) return state;
      return record(state, `search “${words.join(' ')}”`, {
        ...view,
        text: unique([...view.text, ...words]),
      });
    }
    case 'sort': {
      const column = context.columns.find((one) => one.key === action.key);
      if (column?.sortValue === undefined) return state;
      return record(state, `sort ${column.label}`, { ...view, sort: nextSort(view.sort, column) });
    }
    case 'resize': {
      if (!action.widths.every((width) => Number.isFinite(width) && width > 0)) return state;
      return record(state, 'resize columns', { ...view, widths: [...action.widths] });
    }
    case 'undo': {
      const step = state.history.past.at(-1);
      if (step === undefined) return state;
      return {
        view: step.view,
        history: {
          past: state.history.past.slice(0, -1),
          future: [...state.history.future, { label: step.label, view }],
        },
      };
    }
    case 'redo': {
      const step = state.history.future.at(-1);
      if (step === undefined) return state;
      return {
        view: step.view,
        history: {
          past: [...state.history.past, { label: step.label, view }],
          future: state.history.future.slice(0, -1),
        },
      };
    }
  }
}
