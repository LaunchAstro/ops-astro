// SPDX-License-Identifier: AGPL-3.0-only
//
// The business's Docs (#2493 piece 2): the folder tree on the left from `docs.tree`, and the
// chosen page drawn read-only on the right from `docs.page`. Both are `docs:read` on the
// business, so a reader without it sees the plain refusal, never an empty tree. The page's
// Markdown is drawn by the task brief's renderer: nothing the text says becomes markup. The
// two columns sit inside the read state, which wraps what it draws, so the grid is its child.
//
// Piece 4b (#2515): a session whose `session.capabilities` list `docs:write` also sees Edit and
// Move on the page, New folder and New document above the tree, and Rename and Move beside each
// folder (`docs/PageEditor.tsx`, `docs/DocsActs.tsx`); the server still asks `docs:write` on
// every write. After an answer the tree and the page are read again. Everything held for one
// business and sign-in, a draft included, is keyed to them, so a switch starts the screen anew.

import { useState, type ReactElement } from 'react';
import { Empty } from '@launchastro/ui';
import type {
  CapabilitiesResult,
  DocsPageResult,
  DocsTreeResult,
} from '../../../../packages/core-wire/src/index.ts';
import type { ReadState } from '../data/authorised-read.ts';
import { useRead } from '../data/use-read.ts';
import type { RollupFloor } from '../data/rollup-floor.ts';
import type { OperationsClient } from '../operations/client.ts';
import { RecordState } from '../views/record-state.tsx';
import { Markdown } from './task/Markdown.tsx';
import { DocsActForm, type DocsAct } from './docs/DocsActs.tsx';
import { PageEditor } from './docs/PageEditor.tsx';
import { useDocsWrite, type DocsSend } from './docs/docs-write.ts';

type Folder = DocsTreeResult['folders'][number];
type PageEntry = DocsTreeResult['pages'][number];

/** Whether the session holds `docs:write`, as `session.capabilities` answers it. */
const holdsDocsWrite = (state: ReadState<CapabilitiesResult>): boolean =>
  state.outcome === 'ready' &&
  state.value.grants.some((grant) => grant.collection === 'docs' && grant.action === 'write');

/** What a session that may write is handed: the writes, and the act it opens. */
interface Writing {
  readonly send: DocsSend;
  readonly open: (act: DocsAct) => void;
}

/** One folder, its pages and its folders beneath, as a nested list. */
function FolderBranch(props: {
  readonly folder: Folder;
  readonly folders: readonly Folder[];
  readonly pages: readonly PageEntry[];
  readonly chosen: string | null;
  readonly onChoose: (pageId: string) => void;
  readonly writing: Writing | null;
}): ReactElement {
  const { folder, folders, pages, chosen, onChoose, writing } = props;
  const children = folders.filter((each) => each.parentId === folder.id);
  const own = pages.filter((each) => each.folderId === folder.id);
  return (
    <li>
      <span className="docs__folder">{folder.name}</span>
      {writing === null ? null : (
        <span className="docs__folder-acts">
          {(['rename-folder', 'move-folder'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              className="btn btn--ghost btn--sm"
              data-docs-act={kind}
              data-folder-id={folder.id}
              onClick={() => writing.open({ kind, folder })}
            >
              {kind === 'rename-folder' ? 'Rename' : 'Move'}
            </button>
          ))}
        </span>
      )}
      {children.length + own.length > 0 && (
        <ul className="docs__branch">
          {own.map((page) => (
            <li key={page.id}>
              <button
                type="button"
                className="sb__addr"
                data-page-id={page.id}
                aria-current={page.id === chosen ? 'page' : undefined}
                onClick={() => onChoose(page.id)}
              >
                {page.title}
              </button>
            </li>
          ))}
          {children.map((child) => (
            <FolderBranch key={child.id} {...props} folder={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** The chosen page, read on its own so a slow page never holds the tree; Edit and Move with docs:write. */
function DocsPage(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly rollup: RollupFloor;
  readonly pageId: string;
  readonly writing: Writing | null;
  readonly onChanged: () => void;
}): ReactElement {
  const { client, grantKey, pageId, writing } = props;
  const [editing, setEditing] = useState(false);
  const { state, reload } = useRead<DocsPageResult>({
    grantKey,
    run: () => client.read<DocsPageResult>('docs.page', { pageId }),
    deps: [client, pageId],
    rollup: props.rollup,
  });
  return (
    <RecordState state={state} subject="page" onRetry={reload}>
      {({ document }) => (
        <article className="card stack" aria-label={document.title}>
          <h2>{document.title}</h2>
          {writing !== null && !editing ? (
            <div className="row">
              <button
                type="button"
                className="btn"
                data-docs-act="edit"
                onClick={() => setEditing(true)}
              >
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
          ) : null}
          {writing !== null && editing ? (
            <PageEditor
              pageId={document.id}
              version={document.version}
              body={document.body}
              send={writing.send}
              onSaved={() => {
                setEditing(false);
                reload();
                props.onChanged();
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <Markdown source={document.body} />
          )}
        </article>
      )}
    </RecordState>
  );
}

/** The business's top folders, each with its pages and folders beneath. */
function DocsTree(props: {
  readonly tree: DocsTreeResult;
  readonly chosen: string | null;
  readonly onChoose: (pageId: string) => void;
  readonly writing: Writing | null;
}): ReactElement {
  const { tree, chosen, onChoose, writing } = props;
  return (
    <nav className="docs__tree card" aria-label="Folders">
      {writing === null ? null : (
        <div className="row">
          <button
            type="button"
            className="btn btn--sm"
            data-docs-act="new-folder"
            onClick={() => writing.open({ kind: 'new-folder' })}
          >
            New folder
          </button>
          <button
            type="button"
            className="btn btn--sm"
            data-docs-act="new-page"
            onClick={() => writing.open({ kind: 'new-page', folderId: null })}
          >
            New document
          </button>
        </div>
      )}
      <ul className="docs__branch">
        {tree.folders
          .filter((folder) => folder.parentId === null)
          .map((folder) => (
            <FolderBranch
              key={folder.id}
              folder={folder}
              folders={tree.folders}
              pages={tree.pages}
              chosen={chosen}
              onChoose={onChoose}
              writing={writing}
            />
          ))}
      </ul>
    </nav>
  );
}

interface DocsProps {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly rollup: RollupFloor;
}

/** The screen for one business and sign-in: its tree, its page, and what it may write. */
function DocsFor(props: DocsProps): ReactElement {
  const { client, grantKey } = props;
  const [chosen, setChosen] = useState<string | null>(null);
  const [act, setAct] = useState<DocsAct | null>(null);
  const [changes, setChanges] = useState(0);
  const send = useDocsWrite(client, grantKey);
  const capabilities = useRead<CapabilitiesResult>({
    grantKey,
    run: () => client.read<CapabilitiesResult>('session.capabilities', {}),
    deps: [client],
  });
  const { state, reload } = useRead<DocsTreeResult>({
    grantKey,
    run: () => client.read<DocsTreeResult>('docs.tree', {}),
    deps: [client],
    rollup: props.rollup,
    isEmpty: (tree) => tree.folders.length === 0,
  });
  const writing: Writing | null = holdsDocsWrite(capabilities.state)
    ? { send, open: setAct }
    : null;
  const changed = () => {
    reload();
    setChanges((n) => n + 1);
  };
  const folders = state.outcome === 'ready' ? state.value.folders : [];
  return (
    <section className="stack" aria-label="Docs">
      {writing !== null && act !== null ? (
        <DocsActForm
          key={JSON.stringify(act)}
          act={act}
          folders={folders}
          send={send}
          onDone={() => {
            setAct(null);
            changed();
          }}
          onCancel={() => setAct(null)}
        />
      ) : null}
      {writing !== null && state.outcome === 'empty' ? (
        <DocsTree
          tree={{ ok: true, folders: [], pages: [] }}
          chosen={null}
          onChoose={setChosen}
          writing={writing}
        />
      ) : null}
      <RecordState
        state={state}
        subject="docs"
        onRetry={reload}
        empty={
          <Empty
            title="No docs yet."
            description="Folders and pages your team files appear here."
          />
        }
      >
        {(tree) => (
          <div className="docs">
            <DocsTree tree={tree} chosen={chosen} onChoose={setChosen} writing={writing} />
            <div className="docs__page">
              {chosen === null ? (
                <Empty title="Choose a page." description="Pick a page in a folder to read it." />
              ) : (
                <DocsPage
                  key={`${chosen}:${String(changes)}`}
                  client={client}
                  grantKey={grantKey}
                  rollup={props.rollup}
                  pageId={chosen}
                  writing={writing}
                  onChanged={changed}
                />
              )}
            </div>
          </div>
        )}
      </RecordState>
    </section>
  );
}

export function DocsScreen(props: DocsProps): ReactElement {
  // A business or person switch starts the screen anew: no draft, act or choice carries over.
  return <DocsFor key={`${props.client.businessKey}:${props.grantKey}`} {...props} />;
}
