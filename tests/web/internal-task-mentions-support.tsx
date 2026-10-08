// SPDX-License-Identifier: AGPL-3.0-only
import { act, useState } from 'react';
import { OperationsClient } from '../../apps/web/src/operations/client.ts';
import { Comments, type CommentDraft } from '../../apps/web/src/screens/task/Comments.tsx';
import type { InternalCommentView, PersonListResult } from '../../packages/core-wire/src/index.ts';
import { mount, type Mounted } from '../surfaces/mount.tsx';

export const ADA = '00000000-0000-4000-8000-000000000011';
export const BEA = '00000000-0000-4000-8000-000000000012';
export const PEOPLE: PersonListResult = {
  ok: true,
  persons: [
    { personId: ADA, name: 'Ada Synthetic' },
    { personId: BEA, name: 'Bea Synthetic' },
  ],
};
export const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const refusal = (code: string): Response =>
  response({ refused: true, code, names: [], fixes: [] }, 403);

export function transport(businessKey = 'alpha') {
  const requests: { path: string; body: unknown }[] = [];
  let sequence = 0;
  const answers = {
    people: (): Promise<Response> => Promise.resolve(response(PEOPLE)),
    comment: (): Promise<Response> =>
      Promise.resolve(response({ recordId: 'task-one', revision: 4 })),
  };
  const fetch: typeof globalThis.fetch = (url, init) => {
    const path = new URL(String(url), 'http://synthetic.invalid').pathname;
    const body: unknown = JSON.parse(String(init?.body ?? '{}'));
    requests.push({ path, body });
    if (path.endsWith('/person/list')) return answers.people();
    if (path.endsWith('/task/comment')) return answers.comment();
    throw new Error(`Unexpected request ${path}`);
  };
  const client = new OperationsClient({
    origin: '',
    businessKey,
    signedIn: true,
    fetch,
    newOperationId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
  });
  return {
    client,
    requests,
    answers,
    posts: () => requests.filter((r) => r.path.endsWith('/task/comment')),
  };
}

export interface HarnessProps {
  readonly client: OperationsClient;
  readonly recordId?: string;
  readonly grantKey?: string;
  readonly revision?: number;
  readonly comments?: readonly InternalCommentView[];
  readonly posted?: () => void;
  readonly refused?: (because: string) => void;
}
export function Harness(props: HarnessProps) {
  const [draft, onDraft] = useState<CommentDraft | null>(null);
  const [closed, onRefused] = useState<string | null>(null);
  return (
    <Comments
      client={props.client}
      {...(props.grantKey === undefined ? {} : { grantKey: props.grantKey })}
      recordId={props.recordId ?? 'task-one'}
      revision={props.revision ?? 4}
      comments={props.comments ?? []}
      draft={draft}
      onDraft={onDraft}
      refusal={closed}
      onRefused={(because) => {
        onRefused(because);
        props.refused?.(because);
      }}
      onPosted={props.posted ?? (() => {})}
      editing={null}
      onEditing={() => {}}
    />
  );
}
export const open = (props: HarnessProps) => mount(<Harness {...props} />);
export async function key(
  view: Mounted,
  selector: string,
  keyName: string,
  extra: KeyboardEventInit = {},
) {
  const target = view.host.querySelector(selector);
  if (!(target instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
  await act(() => {
    target.focus();
    target.dispatchEvent(
      new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: keyName,
        ...extra,
      }),
    );
  });
}
export async function mentionAda(view: Mounted) {
  await key(view, '[data-internal-task-mentions] button[aria-haspopup="listbox"]', 'ArrowDown');
  await key(view, '[data-internal-task-mentions] button[aria-haspopup="listbox"]', 'ArrowDown');
  await key(view, '[data-internal-task-mentions] button[aria-haspopup="listbox"]', 'Enter');
}

export function deferredResponse() {
  let resolve: ((answer: Response) => void) | undefined;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve: (answer: Response) => {
      if (resolve === undefined) throw new Error('Deferred response not initialised');
      resolve(answer);
    },
  };
}
