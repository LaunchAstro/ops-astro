// SPDX-License-Identifier: AGPL-3.0-only
//
// The business's Docs (#2493 piece 2): the folder tree on the left from `docs.tree`, and the
// chosen page drawn read-only on the right from `docs.page`. Both are `docs:read` on the
// business, so a reader without it sees the plain refusal, never an empty tree. The page's
// Markdown is drawn by the task brief's renderer: nothing the text says becomes markup.

import { useState, type ReactElement } from 'react';
import { Empty } from '@launchastro/ui';
import type { DocsPageResult, DocsTreeResult } from '../../../../packages/core-wire/src/index.ts';
import { useRead } from '../data/use-read.ts';
import type { RollupFloor } from '../data/rollup-floor.ts';
import type { OperationsClient } from '../operations/client.ts';
import { RecordState } from '../views/record-state.tsx';
import { Markdown } from './task/Markdown.tsx';

type Folder = DocsTreeResult['folders'][number];
type PageEntry = DocsTreeResult['pages'][number];

/** One folder, its pages and its folders beneath, as a nested list. */
function FolderBranch(props: {
  readonly folder: Folder;
  readonly folders: readonly Folder[];
  readonly pages: readonly PageEntry[];
  readonly chosen: string | null;
  readonly onChoose: (pageId: string) => void;
}): ReactElement {
  const { folder, folders, pages, chosen, onChoose } = props;
  const children = folders.filter((each) => each.parentId === folder.id);
  const own = pages.filter((each) => each.folderId === folder.id);
  return (
    <li>
      <span className="docs__folder">{folder.name}</span>
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

/** The chosen page, read on its own so a slow page never holds the tree. */
function DocsPage(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly rollup: RollupFloor;
  readonly pageId: string;
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
        <article className="card stack" aria-label={document.title}>
          <h2>{document.title}</h2>
          <Markdown source={document.body} />
        </article>
      )}
    </RecordState>
  );
}

export function DocsScreen(props: {
  readonly client: OperationsClient;
  readonly grantKey: string;
  readonly rollup: RollupFloor;
}): ReactElement {
  const { client, grantKey } = props;
  const [chosen, setChosen] = useState<string | null>(null);
  const { state, reload } = useRead<DocsTreeResult>({
    grantKey,
    run: () => client.read<DocsTreeResult>('docs.tree', {}),
    deps: [client],
    rollup: props.rollup,
    isEmpty: (tree) => tree.folders.length === 0,
  });
  return (
    <section className="docs" aria-label="Docs">
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
          <>
            <nav className="docs__tree card" aria-label="Folders">
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
                      onChoose={setChosen}
                    />
                  ))}
              </ul>
            </nav>
            <div className="docs__page">
              {chosen === null ? (
                <Empty title="Choose a page." description="Pick a page in a folder to read it." />
              ) : (
                <DocsPage
                  key={chosen}
                  client={client}
                  grantKey={grantKey}
                  rollup={props.rollup}
                  pageId={chosen}
                />
              )}
            </div>
          </>
        )}
      </RecordState>
    </section>
  );
}
