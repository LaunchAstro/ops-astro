// SPDX-License-Identifier: AGPL-3.0-only
//
// The chosen Docs page (#2493 piece 2), read on its own so a slow page never holds the tree,
// drawn read-only by the task brief's renderer. With docs:write (#2515), Edit opens the editor
// on the version it read (`PageEditor.tsx`) and Move opens the page's move act; after a save the
// page and the tree are read again.

import { useState, type ReactElement } from 'react';
import type { DocsPageResult } from '../../../../../packages/core-wire/src/index.ts';
import { useRead } from '../../data/use-read.ts';
import type { RollupFloor } from '../../data/rollup-floor.ts';
import type { OperationsClient } from '../../operations/client.ts';
import { RecordState } from '../../views/record-state.tsx';
import { Markdown } from '../task/Markdown.tsx';
import { PageEditor } from './PageEditor.tsx';
import type { Writing } from './DocsTree.tsx';

type Document = DocsPageResult['document'];

/** Edit and Move on a page. */
function PageActs(props: {
  readonly document: Document;
  readonly writing: Writing;
  readonly onEdit: () => void;
}): ReactElement {
  const { document, writing } = props;
  return (
    <div className="row">
      <button type="button" className="btn" data-docs-act="edit" onClick={props.onEdit}>
        Edit
      </button>
      <button
        type="button"
        className="btn"
        data-docs-act="move-page"
        onClick={() =>
          writing.open({
            kind: 'move-page',
            pageId: document.id,
            version: document.version,
            folderId: document.folderId,
          })
        }
      >
        Move
      </button>
    </div>
  );
}

/** One read page: its title, then the editor or the rendered Markdown. */
function PageBody(props: {
  readonly document: Document;
  readonly writing: Writing | null;
  readonly onSaved: () => void;
}): ReactElement {
  const { document, writing } = props;
  const [editing, setEditing] = useState(false);
  const open = writing !== null && editing;
  return (
    <article className="card stack" aria-label={document.title}>
      <h2>{document.title}</h2>
      {writing !== null && !editing ? (
        <PageActs document={document} writing={writing} onEdit={() => setEditing(true)} />
      ) : null}
      {open ? (
        <PageEditor
          pageId={document.id}
          version={document.version}
          body={document.body}
          send={writing.send}
          onSaved={() => {
            setEditing(false);
            props.onSaved();
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <Markdown source={document.body} />
      )}
    </article>
  );
}

export function DocsPage(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly rollup: RollupFloor;
  readonly pageId: string;
  readonly writing: Writing | null;
  readonly onChanged: () => void;
}): ReactElement {
  const { client, grantKey, pageId } = props;
  const { state, reload } = useRead<DocsPageResult>({
    grantKey,
    run: () => client.read<DocsPageResult>('docs.page', { pageId }),
    deps: [client, pageId],
    rollup: props.rollup,
  });
  return (
    <RecordState state={state} subject="page" onRetry={reload}>
      {({ document }) => (
        <PageBody
          document={document}
          writing={props.writing}
          onSaved={() => {
            reload();
            props.onChanged();
          }}
        />
      )}
    </RecordState>
  );
}
