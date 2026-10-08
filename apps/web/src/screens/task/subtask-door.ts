// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef } from 'react';
import type { PanelDoor, Perspective } from './Perspectives.tsx';

type SubtaskOpening = { readonly door: PanelDoor };

export function useSubtaskDoor(
  opening: SubtaskOpening,
  taskId: string,
  perspective: Perspective,
  select: (next: Perspective) => void,
) {
  const body = useRef<HTMLDivElement>(null);
  const focusedOpening = useRef<SubtaskOpening | null>(null);
  useEffect(() => {
    if (opening.door !== 'add-first' || focusedOpening.current === opening) return;
    if (perspective !== 'team') {
      select('team');
      return;
    }
    const input = body.current?.querySelector<HTMLInputElement>('[data-step-add]');
    if (input === undefined || input === null) return;
    focusedOpening.current = opening;
    input.focus();
    input?.scrollIntoView?.({ block: 'nearest' });
  }, [opening, taskId, perspective, select]);
  return body;
}
