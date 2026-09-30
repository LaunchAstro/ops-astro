// SPDX-License-Identifier: AGPL-3.0-only
//
// The dock task panel's page link (MP-4-12, CS-4.4, CS-4.22, DP-29, DP-30):
// the in-product address the task is about.
//
// **Link here takes the address being read.** Its path and hash, sent through
// `task.update` at the revision the panel read; once linked it reads Relink
// and re-points the link the same way. A landed link is counted, so the panel
// and the page read the task again.
//
// **A door only inside the product.** The server keeps only an in-product
// address (`isInProductLink`); a stored value that fails the same rule (a
// row written before the rule, or by hand) is drawn as words, never as a
// link, and the head draws no go-to for it.
//
// The pin (CS-4.7, DP-10) waits on the preference model.

import type { ReactElement } from 'react';
import type { OperationsClient } from '../../operations/client.ts';
import {
  isInProductLink,
  type InternalTaskDetail as Task,
} from '../../../../../packages/core-wire/src/index.ts';
import { useCommand } from '../../records/use-command.ts';
import { submitEdit } from '../../records/submit.ts';

export interface PageLinkProps {
  readonly client: OperationsClient;
  readonly task: Task;
  readonly onChanged: () => void;
}

/** The task's link as a door, or nothing when it has none or it leads out of the product. */
export function pageLinkDoor(task: Pick<Task, 'pageLink'>): string | null {
  return isInProductLink(task.pageLink) ? task.pageLink : null;
}

export function PageLink(props: PageLinkProps): ReactElement {
  const { client, task } = props;
  const { busy, because, run } = useCommand();
  const door = pageLinkDoor(task);
  const linkHere = (): void => {
    const here = `${window.location.pathname}${window.location.hash}`;
    run(
      () =>
        submitEdit(client, {
          command: 'task.update',
          recordId: task.id,
          expectedRevision: task.revision,
          fields: { page_link: here },
        }),
      (settlement) => {
        if (settlement.kind === 'ok') props.onChanged();
      },
    );
  };
  return (
    <div className="dtp__link">
      <span className="tf__k">Page</span>
      {door === null ? (
        <span className="card__sub" data-page-link="value">
          {task.pageLink ?? 'Not linked'}
        </span>
      ) : (
        <a className="t-link" data-page-link="value" href={door} title={door}>
          {door}
        </a>
      )}
      <button className="btn" type="button" data-page-link="set" disabled={busy} onClick={linkHere}>
        {task.pageLink === null ? 'Link here' : 'Relink'}
      </button>
      {because === null ? null : (
        <p className="field__error" role="alert">
          {because}
        </p>
      )}
    </div>
  );
}
