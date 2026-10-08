// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from 'react';
import type { BoardTask } from '../../../../../packages/core-wire/src/index.ts';
export function useBoardTarget(
  rows: readonly BoardTask[],
  target: string | undefined,
  generation: number,
) {
  const wrap = useRef<HTMLDivElement>(null),
    focused = useRef<string | null>(null);
  const opening = `${String(generation)}:${target ?? ''}`;
  useEffect(() => {
    const row = rows.find((task) => task.key === target || task.id === target);
    if (row === undefined || target === undefined || focused.current === opening) return;
    const focus = (): boolean => {
      const node = Array.from(wrap.current?.querySelectorAll<HTMLElement>('[data-row]') ?? []).find(
        (element) => element.dataset['row'] === row.id,
      );
      const link = node?.querySelector<HTMLElement>('a.cbd__nm');
      if (node === undefined || link === null || link === undefined) return false;
      focused.current = opening;
      link.focus();
      node.scrollIntoView?.({ block: 'nearest' });
      return true;
    };
    if (focus() || wrap.current === null) return;
    const observer = new MutationObserver(() => {
      if (focus()) observer.disconnect();
    });
    observer.observe(wrap.current, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [rows, target, opening]);
  return wrap;
}
