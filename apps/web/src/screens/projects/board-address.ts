// SPDX-License-Identifier: AGPL-3.0-only
import { useRef, useState } from 'react';
import { decodeBoardAddress, type BoardAddress } from './scoped-board.ts';
const queryOf = (address: string | undefined): string =>
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
  const [held, setHeld] = useState(() => ({ observed: external, query: external, generation: 0 }));
  let current = held;
  if (external !== held.observed) {
    current =
      hidden || returning || external === written.current
        ? { ...held, observed: external }
        : { observed: external, query: external, generation: held.generation + 1 };
    setHeld(current);
  }
  return {
    query: current.query,
    generation: current.generation,
    write: (next: string) => {
      if (hidden || inPanel) return;
      written.current = next === '' ? '' : `?${next}`;
      window.history.replaceState(
        window.history.state,
        '',
        `${window.location.pathname}${written.current}${window.location.hash}`,
      );
    },
  };
}
