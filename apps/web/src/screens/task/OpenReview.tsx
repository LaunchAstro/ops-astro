// SPDX-License-Identifier: AGPL-3.0-only
//
// The task page's Open a review (C35, PROTO-GAPS row 4): a page the task's site binds and its
// file, sent as `review.open`, which opens the task's review of that page or adds its next
// revision; the answer's review is the workspace the page goes to. No read names a task's bound
// pages yet, so the person types them; the server refuses a page the site does not bind, in its
// own words. The site's version is `live`: the page as it is published now. One attempt id per
// page the person means, kept until that attempt is answered, so a retry after a lost answer
// opens once. An answer is for the form and the reader that sent it: once the form is gone, or
// the business, person or task under it changed, the answer goes nowhere (#2232).

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Button, FormLayout, TextField } from '@launchastro/ui';
import { isUnavailable, type OperationsClient } from '../../operations/client.ts';
import { useCommand } from '../../records/use-command.ts';

/** The page as it is published now: no read gives the site's own revision of it yet. */
export const LIVE_SOURCE = 'live';

export interface OpenReviewProps {
  readonly client: OperationsClient;
  readonly taskId: string;
  /** Told the opened review, to go to its workspace. */
  readonly onOpened: (reviewId: string) => void;
}

/** Who an answer is for: the reader's client (a new sign-in or business is a new one) and the task. */
interface Reader {
  readonly client: OperationsClient;
  readonly taskId: string;
}

/** The form's current reader, null once the form unmounts. */
function useReader(client: OperationsClient, taskId: string) {
  const reader = useRef<Reader | null>(null);
  useEffect(() => {
    reader.current = { client, taskId };
    return () => {
      reader.current = null;
    };
  }, [client, taskId]);
  return reader;
}

/** The typed page and file, and their open: one attempt id per meant page. */
function useOpenReview(props: OpenReviewProps) {
  const [pageUrl, setPageUrl] = useState('');
  const [path, setPath] = useState('');
  const { busy, because, run, reset } = useCommand();
  const reader = useReader(props.client, props.taskId);
  // Each meant page's attempt id in its business, kept until that attempt is answered.
  const held = useRef(new Map<string, string>());
  const submit = (): void => {
    if (busy || pageUrl.trim() === '' || path.trim() === '') return;
    const command = {
      taskId: props.taskId,
      pageUrl: pageUrl.trim(),
      path: path.trim(),
      sourceRevision: LIVE_SOURCE,
    };
    const intent = JSON.stringify([props.client.businessKey, command]);
    const { client, taskId } = props;
    const operationId = held.current.get(intent) ?? props.client.newOperationId();
    held.current.set(intent, operationId);
    run(
      async () => {
        const answer = await props.client.mutate('review.open', command, { operationId });
        if (!isUnavailable(answer)) held.current.delete(intent);
        return answer;
      },
      (settlement) => {
        const now = reader.current;
        if (now?.client !== client || now.taskId !== taskId) {
          // Another reader's form, or none: nothing of this answer is theirs.
          if (now !== null) reset();
          return;
        }
        if (settlement.kind === 'ok') props.onOpened(settlement.value.recordId);
      },
    );
  };
  return { pageUrl, setPageUrl, path, setPath, busy, because, submit };
}

export function OpenReview(props: OpenReviewProps): ReactElement {
  const [open, setOpen] = useState(false);
  const { pageUrl, setPageUrl, path, setPath, busy, because, submit } = useOpenReview(props);
  if (!open) {
    return (
      <div data-open-review="start">
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Open a review
        </Button>
      </div>
    );
  }
  return (
    <FormLayout
      label="Open a review of a page"
      onSubmit={submit}
      actions={
        <>
          <Button variant="primary" type="submit" {...(busy ? { busy: 'Opening…' } : {})}>
            Open review
          </Button>
          <Button variant="text" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </>
      }
    >
      <div data-open-review="pageUrl">
        <TextField
          label="Page address"
          placeholder="https://example.com/about"
          value={pageUrl}
          onChange={setPageUrl}
        />
      </div>
      <div data-open-review="path">
        <TextField
          label="Its file in the site"
          placeholder="src/pages/about.astro"
          value={path}
          onChange={setPath}
          error={because ?? undefined}
        />
      </div>
    </FormLayout>
  );
}
