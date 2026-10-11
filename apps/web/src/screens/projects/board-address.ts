// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState } from 'react';
import { decodeBoardAddress, type BoardAddress } from './scoped-board.ts';
export const queryOf = (address: string | undefined): string =>
  address === undefined ? window.location.search : new URL(address, 'http://here').search;
/** The board scope an address names, or null when it names none that is valid. */
export function addressScope(address: string | undefined): BoardAddress | null {
  const scope = decodeBoardAddress(queryOf(address));
  return scope.kind === 'invalid' ? null : scope;
}
/** A board keeps its view through its own writes and hidden Work log returns. */
export function useProjectBoardAddress(
  address: string | undefined,
  inPanel: boolean,
  hidden: boolean,
) {
  const external = queryOf(address);
  const written = useRef<string | null>(null);
  const wasHidden = useRef(hidden);
  const returning = wasHidden.current && !hidden;
  wasHidden.current = hidden;
  const [held, setHeld] = useState(() => ({
    observed: external,
    query: external,
    view: external,
    generation: 0,
  }));
  let current = held;
  if (external !== held.observed) {
    current =
      hidden || returning || external === written.current
        ? { ...held, observed: external }
        : { observed: external, query: external, view: external, generation: held.generation + 1 };
    setHeld(current);
  }
  return {
    query: current.query,
    /** The query of the view the board shows now, its own writes included: what its doors carry. */
    view: current.view,
    generation: current.generation,
    write: (next: string) => {
      if (hidden) return;
      const view = next === '' ? '' : `?${next}`;
      setHeld((before) => (before.view === view ? before : { ...before, view }));
      if (inPanel) return;
      written.current = view;
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${written.current}${window.location.hash}`,
      );
    },
  };
}
