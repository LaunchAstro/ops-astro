// SPDX-License-Identifier: AGPL-3.0-only
//
// The Docs screen's filing acts (#2515, piece 4b): New folder and New document (piece 1's
// docs.create_folder and docs.create_page), a folder's rename and move (piece 4a's
// docs.rename_folder and docs.move_folder), and a page's move (docs.update_page naming the
// version it was opened at and the folder it goes to). Each is one small form: what was typed
// stays when the server refuses, in the server's words, and the tree is read again after an
// answer, never patched here.

import { useState, type ReactElement } from 'react';
import type { DocsTreeResult } from '../../../../../packages/core-wire/src/index.ts';
import type { DocsSend, DocsWriteName } from './docs-write.ts';

type Folder = DocsTreeResult['folders'][number];

/** Which act is open, and on what. */
export type DocsAct =
  | { readonly kind: 'new-folder' }
  | { readonly kind: 'new-page'; readonly folderId: string | null }
  | { readonly kind: 'rename-folder'; readonly folder: Folder }
  | { readonly kind: 'move-folder'; readonly folder: Folder }
  | {
      readonly kind: 'move-page';
      readonly pageId: string;
      readonly version: number;
      readonly folderId: string;
    };

interface Typed {
  readonly name: string;
  readonly title: string;
  readonly folder: string;
}

const TOP = '';

/** The command and body one act sends, from what was typed. */
function requestOf(act: DocsAct, typed: Typed): readonly [DocsWriteName, Record<string, unknown>] {
  switch (act.kind) {
    case 'new-folder':
      return ['docs.create_folder', { name: typed.name }];
    case 'new-page':
      return ['docs.create_page', { folderId: typed.folder, title: typed.title, body: '' }];
    case 'rename-folder':
      return ['docs.rename_folder', { folderId: act.folder.id, name: typed.name }];
    case 'move-folder':
      return [
        'docs.move_folder',
        { folderId: act.folder.id, ...(typed.folder === TOP ? {} : { parentId: typed.folder }) },
      ];
    case 'move-page':
      return [
        'docs.update_page',
        { pageId: act.pageId, expectedVersion: act.version, folderId: typed.folder },
      ];
  }
}

/** One intent per act and target: the same act on the same folder or page, pressed again, is a retry. */
const intentOf = (act: DocsAct): string =>
  act.kind === 'rename-folder' || act.kind === 'move-folder'
    ? `${act.kind}:${act.folder.id}`
    : act.kind === 'move-page'
      ? `${act.kind}:${act.pageId}`
      : act.kind;

const LABELS: Readonly<Record<DocsAct['kind'], string>> = {
  'new-folder': 'New folder',
  'new-page': 'New document',
  'rename-folder': 'Rename folder',
  'move-folder': 'Move folder',
  'move-page': 'Move document',
};

function startOf(act: DocsAct, folders: readonly Folder[]): Typed {
  const first = folders[0]?.id ?? TOP;
  switch (act.kind) {
    case 'new-page':
      return { name: '', title: '', folder: act.folderId ?? first };
    case 'rename-folder':
      return { name: act.folder.name, title: '', folder: TOP };
    case 'move-folder':
      return { name: '', title: '', folder: act.folder.parentId ?? TOP };
    case 'move-page':
      return { name: '', title: '', folder: act.folderId };
    default:
      return { name: '', title: '', folder: first };
  }
}

/** The folders an act may choose: a folder never moves under itself, and a folder may go to the top. */
function FolderChoice(props: {
  readonly act: DocsAct;
  readonly folders: readonly Folder[];
  readonly value: string;
  readonly onChoose: (folder: string) => void;
}): ReactElement {
  const { act, folders } = props;
  const own = act.kind === 'move-folder' ? act.folder.id : null;
  return (
    <div className="field">
      <label className="tf__k" htmlFor="docs-act-folder">
        {act.kind === 'new-page' ? 'In folder' : 'To folder'}
      </label>
      <select
        id="docs-act-folder"
        className="input"
        data-docs-field="folder"
        value={props.value}
        onChange={(event) => props.onChoose(event.target.value)}
      >
        {act.kind === 'move-folder' ? <option value={TOP}>Top level</option> : null}
        {folders
          .filter((folder) => folder.id !== own)
          .map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
      </select>
    </div>
  );
}

function TextField(props: {
  readonly field: 'name' | 'title';
  readonly label: string;
  readonly value: string;
  readonly onType: (value: string) => void;
}): ReactElement {
  return (
    <div className="field">
      <label className="tf__k" htmlFor={`docs-act-${props.field}`}>
        {props.label}
      </label>
      <input
        id={`docs-act-${props.field}`}
        className="input"
        type="text"
        data-docs-field={props.field}
        value={props.value}
        onChange={(event) => props.onType(event.target.value)}
      />
    </div>
  );
}

/** One open act: its fields, Send and Cancel, and the server's words when it refuses. */
export function DocsActForm(props: {
  readonly act: DocsAct;
  readonly folders: readonly Folder[];
  readonly send: DocsSend;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}): ReactElement {
  const { act, folders, send } = props;
  const [typed, setTyped] = useState<Typed>(() => startOf(act, folders));
  const [words, setWords] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const named = act.kind === 'new-folder' || act.kind === 'rename-folder';
  const chooses = act.kind !== 'new-folder' && act.kind !== 'rename-folder';
  const press = async () => {
    const [name, body] = requestOf(act, typed);
    setBusy(true);
    const answer = await send(intentOf(act), name, body);
    setBusy(false);
    if (answer.kind === 'done') props.onDone();
    if (answer.kind === 'refused') setWords(answer.words);
  };
  return (
    <form
      className="card stack"
      aria-label={LABELS[act.kind]}
      onSubmit={(event) => {
        event.preventDefault();
        void press();
      }}
    >
      <h3>{LABELS[act.kind]}</h3>
      {named ? (
        <TextField
          field="name"
          label="Name"
          value={typed.name}
          onType={(name) => setTyped({ ...typed, name })}
        />
      ) : null}
      {act.kind === 'new-page' ? (
        <TextField
          field="title"
          label="Title"
          value={typed.title}
          onType={(title) => setTyped({ ...typed, title })}
        />
      ) : null}
      {chooses ? (
        <FolderChoice
          act={act}
          folders={folders}
          value={typed.folder}
          onChoose={(folder) => setTyped({ ...typed, folder })}
        />
      ) : null}
      {words === null ? null : (
        <p className="field__error" role="alert" data-docs-refusal="">
          {words}
        </p>
      )}
      <div className="row">
        <button className="btn btn--primary" type="submit" data-docs-act="send" disabled={busy}>
          {busy ? 'Sending…' : LABELS[act.kind]}
        </button>
        <button className="btn" type="button" data-docs-act="cancel" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
