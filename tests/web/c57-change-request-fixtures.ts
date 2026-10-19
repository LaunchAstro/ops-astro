// SPDX-License-Identifier: AGPL-3.0-only
//
// C57 part C's panel fixtures (#2119): made-up change requests and pins, the panel's props, and
// a stand-in client whose every call is held until the test answers it, as the server would.

import type { ChangeRequestPanelProps } from '../../apps/web/src/screens/review/ChangeRequests.tsx';
import type {
  ChangeRequestView,
  PinView,
} from '../../apps/web/src/screens/review/change-requests.ts';
import type { DockClient } from '../../apps/web/src/screens/review/use-change-requests.ts';

export const MARKER = 'client-words-marker-7f3a';

export const request = (over: Partial<ChangeRequestView> = {}): ChangeRequestView => ({
  changeRequestId: 'cr-1',
  commentId: 'pin-1',
  state: 'proposed',
  text: `Move the heading ${MARKER}`,
  createdTaskId: null,
  ...over,
});

export const pin = (over: Partial<PinView> = {}): PinView =>
  ({
    commentId: 'pin-9',
    audience: 'client',
    body: 'Can the photo sit lower?',
    anchor: { source: 'rev-1', selector: [] },
    ...over,
  }) as PinView;

export const props = (over: Partial<ChangeRequestPanelProps> = {}): ChangeRequestPanelProps => ({
  load: { kind: 'ready', requests: [request()], pins: [] },
  canDecide: true,
  busy: null,
  note: null,
  agent: 'CLIENT_MODEL_USE_OFF',
  onDecide: () => {},
  onFile: () => {},
  onOpenTask: () => {},
  ...over,
});

/** A stand-in client: each call is held until the test answers it. */
export function standIn(businessKey = 'alpha') {
  const calls: {
    name: string;
    body: Readonly<Record<string, unknown>>;
    operationId?: string;
    answer: (value: unknown) => void;
  }[] = [];
  let minted = 0;
  const client: DockClient = {
    businessKey,
    newOperationId: () => `op-${String((minted += 1))}`,
    read: async (name, body) =>
      await new Promise((resolve) => {
        calls.push({ name, body, answer: resolve as (value: unknown) => void });
      }),
    mutate: async (name, body, options) =>
      await new Promise((resolve) => {
        calls.push({
          name,
          body,
          ...(options?.operationId === undefined ? {} : { operationId: options.operationId }),
          answer: resolve as (value: unknown) => void,
        });
      }),
  };
  return { client, calls };
}

export const ok = (value: unknown) => ({ ok: true, value });
export const refusal = (code: string, fixes: readonly string[] = []) => ({
  refused: true,
  code,
  names: [],
  fixes,
});
export const reviewAnswer = (
  requests: readonly ChangeRequestView[],
  pins: readonly PinView[] = [],
) => ok({ ok: true, review: { reviewId: 'rv', changeRequests: requests, pins } });
export const holding = (grants: readonly (readonly [string, string])[]) =>
  ok({
    personId: 'p',
    businessKey: 'alpha',
    grants: grants.map(([collection, action]) => ({ collection, action })),
  });

/** A drawn element's `data-*` value, read as the DOM's dataset. */
export const dataOf = (element: Element | null | undefined, key: string): string | undefined =>
  (element as HTMLElement | null | undefined)?.dataset[key];
