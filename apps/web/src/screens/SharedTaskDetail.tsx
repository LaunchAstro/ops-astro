// SPDX-License-Identifier: AGPL-3.0-only
//
// `/task/:key` for a reader outside the business (minimum contract 8.1 R4):
// the server's shared projection, drawn as it arrived.
//
// **Only what the server sent.** The projection carries the task's
// identifier, the fields the catalogue marks `shared` and the client comments.
// This view draws those three and nothing else. The shipped task spine marks
// `title` and `state` shared, so they arrive among the fields, `state` as the
// state's label (`readSharedTask`, I09 ruling); the revision never does, and
// the view does not fetch it, borrow it from another read or fill a gap with a
// word of its own. A field is shown under the key the server used, because the
// projection carries no label and a label invented here would be a claim about
// the field nobody made.
//
// **Nothing on it writes.** An external share is read only
// (`packages/core-records/src/authority/shares.ts`), so there is no comment
// box, no lifecycle button, no assignment and no proposal control. A control
// that could only ever be refused is not offered.

import type { ReactElement } from 'react';
import { Empty } from '@launchastro/ui';
import type { SharedTaskView } from '../../../../packages/core-wire/src/index.ts';

export interface SharedTaskDetailProps {
  readonly task: SharedTaskView;
}

export function SharedTaskDetail(props: SharedTaskDetailProps): ReactElement {
  const { task } = props;
  const fields = Object.entries(task.fields);
  return (
    <div className="stack" data-task={task.id} data-task-view="shared">
      <header className="tpr">
        <span className="sb__addr">Shared with you</span>
      </header>

      <section className="sb__sect" data-shared-fields="section">
        <div className="sb__sh">
          <span className="sb__k">Shared fields</span>
        </div>
        {fields.length === 0 ? (
          <Empty look="inline" title="No field on this task is shared." />
        ) : (
          <dl className="taskform">
            {fields.map(([key, value]) => (
              <div className="field" data-shared-field={key} key={key}>
                <dt className="tf__k">{key}</dt>
                <dd className="card__body">{valueWord(value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <SharedComments comments={task.comments} />
    </div>
  );
}

/** The client comments the projection carried, oldest first, and nothing to write with. */
function SharedComments(props: { readonly comments: SharedTaskView['comments'] }): ReactElement {
  return (
    <section className="sb__sect" data-comments="section">
      <div className="sb__sh">
        <span className="sb__k">Comments</span>
        <span className="sbact__meta">{props.comments.length} shared with you</span>
      </div>
      {props.comments.length === 0 ? (
        <Empty look="inline" title="Nothing on this task has been shared with you yet." />
      ) : (
        <div className="thread" data-comments="list">
          {props.comments.map((comment) => {
            // The projection's fields are the catalogue's to choose, so each one
            // is drawn only when it arrived as text.
            const id = text(comment['id']) ?? '';
            const audience = text(comment['audience']) ?? 'unknown';
            const postedAt = text(comment['posted_at']);
            return (
              <article
                className={`msg msg--${audience}`}
                data-comment-id={id}
                data-audience={audience}
                key={id}
              >
                <div className="sbact__meta">
                  {postedAt === undefined ? null : <span>{postedAt}</span>}
                </div>
                <p className="card__body">{text(comment['body']) ?? ''}</p>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** A shared value as text. `null` is a real answer: the field has no value. */
function valueWord(value: unknown): string {
  if (value === null || value === undefined) return 'No value';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** A shared field as text, or nothing when it did not arrive as text. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
