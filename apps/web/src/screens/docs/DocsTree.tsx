// SPDX-License-Identifier: AGPL-3.0-only
//
// The Docs screen's folder tree (#2493 piece 2): the business's top folders, each with its pages
// and folders beneath. With docs:write (#2515), New folder and New document above it, and Rename
// and Move beside each folder; each opens its act on the screen (`DocsActs.tsx`).

import type { ReactElement } from 'react';
import type { DocsTreeResult } from '../../../../../packages/core-wire/src/index.ts';
import type { DocsAct } from './DocsActs.tsx';
import type { DocsSend } from './docs-write.ts';

type Folder = DocsTreeResult['folders'][number];
type PageEntry = DocsTreeResult['pages'][number];

/** What a session that may write is handed: the writes, and the act it opens. */
export interface Writing {
  readonly send: DocsSend;
  readonly open: (act: DocsAct) => void;
}

/** A folder's Rename and Move. */
function FolderActs(props: { readonly folder: Folder; readonly writing: Writing }): ReactElement {
  const { folder, writing } = props;
  return (
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
  );
}

interface Branch {
  readonly folders: readonly Folder[];
  readonly pages: readonly PageEntry[];
  readonly chosen: string | null;
  readonly onChoose: (pageId: string) => void;
  readonly writing: Writing | null;
}

/** One folder, its pages and its folders beneath, as a nested list. */
function FolderBranch(props: Branch & { readonly folder: Folder }): ReactElement {
  const { folder, folders, pages, chosen, onChoose, writing } = props;
  const children = folders.filter((each) => each.parentId === folder.id);
  const own = pages.filter((each) => each.folderId === folder.id);
  return (
    <li>
      <span className="docs__folder">{folder.name}</span>
      {writing === null ? null : <FolderActs folder={folder} writing={writing} />}
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

/** New folder and New document, above the tree. */
function TreeActs(props: { readonly writing: Writing }): ReactElement {
  const { open } = props.writing;
  return (
    <div className="row">
      <button
        type="button"
        className="btn btn--sm"
        data-docs-act="new-folder"
        onClick={() => open({ kind: 'new-folder' })}
      >
        New folder
      </button>
      <button
        type="button"
        className="btn btn--sm"
        data-docs-act="new-page"
        onClick={() => open({ kind: 'new-page', folderId: null })}
      >
        New document
      </button>
    </div>
  );
}

/** The business's top folders, each with its pages and folders beneath. */
export function DocsTree(props: {
  readonly tree: DocsTreeResult;
  readonly chosen: string | null;
  readonly onChoose: (pageId: string) => void;
  readonly writing: Writing | null;
}): ReactElement {
  const { tree, writing } = props;
  return (
    <nav className="docs__tree card" aria-label="Folders">
      {writing === null ? null : <TreeActs writing={writing} />}
      <ul className="docs__branch">
        {tree.folders
          .filter((folder) => folder.parentId === null)
          .map((folder) => (
            <FolderBranch
              key={folder.id}
              folder={folder}
              folders={tree.folders}
              pages={tree.pages}
              chosen={props.chosen}
              onChoose={props.onChoose}
              writing={writing}
            />
          ))}
      </ul>
    </nav>
  );
}
