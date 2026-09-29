// SPDX-License-Identifier: AGPL-3.0-only
//
// The one mark that follows a current item, shared by the railmark (MP-2-2)
// and the tab row's underline (MP-2-6). Internal to the package: `index.ts`
// does not export it.

import { useLayoutEffect, useRef, useState } from 'react';

/**
 * A mark that follows the current item: snapped into place on load, sliding
 * once the current item has changed. `key` names the current item; the ref is
 * the element holding the items, and `select` finds the current one inside it.
 */
export function useMark<Box>(
  key: string | null,
  measure: (item: HTMLElement) => Box,
  select: string,
): {
  readonly holder: React.RefObject<HTMLDivElement | null>;
  readonly box: Box | null;
  readonly placing: boolean;
} {
  const holder = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState<Box | null>(null);
  const first = useRef<string | null | undefined>(undefined);
  const moved = useRef(false);
  if (first.current === undefined && key !== null) first.current = key;
  if (key !== null && first.current !== undefined && key !== first.current) moved.current = true;
  useLayoutEffect(() => {
    const item = holder.current?.querySelector<HTMLElement>(select) ?? null;
    setBox(item === null ? null : measure(item));
  }, [key, measure, select]);
  return { holder, box, placing: !moved.current };
}
