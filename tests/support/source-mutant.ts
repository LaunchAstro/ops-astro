// SPDX-License-Identifier: AGPL-3.0-only
//
// A disposable copy of the product source with one line changed, loaded as a
// module of its own.
//
// A mutation proof has to run the code the product runs, and the product
// cannot carry a switch that turns its own tenant filter off. So the switch is
// the copy: the source trees are copied under `.local/mutants/<id>/`, one
// exact line is replaced in the copy, and the copy's own entry module is
// imported. Everything the copy imports is the copy, so its `lockTask`, its
// envelope and its handlers are the shipped ones with the one line gone, and
// the shipped modules loaded by the rest of the run are untouched.
//
// The copy lives inside the repository, under the ignored `.local/`, rather
// than in the system temp directory, so a bare import such as `postgres`
// still resolves to the repository's own `node_modules` by walking up.
//
// The replacement must match exactly once. A line that moved or was reworded
// fails the load, so the proof cannot quietly run unmutated code and pass.

import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO = resolve(import.meta.dirname, '../..');

/** The source trees a core-records module can reach through relative imports. */
const DEFAULT_TREES: readonly string[] = ['packages/core-records/src', 'packages/core-runtime/src'];

export interface MutationSpec {
  /** Repository-relative file the mutation edits. */
  readonly file: string;
  /** The exact text to replace; it must occur exactly once in `file`. */
  readonly from: string;
  readonly to: string;
  /** Repository-relative trees to copy; they must include `file` and every module reached. */
  readonly trees?: readonly string[];
}

export interface SourceMutant {
  /** The copy's root, laid out like the repository. */
  readonly root: string;
  /** Import a repository-relative module from the copy. */
  load<T>(entry: string): Promise<T>;
  dispose(): void;
}

export function createSourceMutant(spec: MutationSpec): SourceMutant {
  const trees = spec.trees ?? DEFAULT_TREES;
  if (!trees.some((tree) => spec.file.startsWith(`${tree}/`))) {
    throw new Error(`source mutant: ${spec.file} is outside the copied trees`);
  }
  const root = join(REPO, '.local', 'mutants', randomUUID());
  try {
    for (const tree of trees) {
      mkdirSync(dirname(join(root, tree)), { recursive: true });
      cpSync(join(REPO, tree), join(root, tree), { recursive: true });
    }
    const target = join(root, spec.file);
    const source = readFileSync(target, 'utf8');
    const matches = source.split(spec.from).length - 1;
    if (matches !== 1) {
      throw new Error(`source mutant: expected one match in ${spec.file}, found ${matches}`);
    }
    writeFileSync(target, source.replace(spec.from, spec.to));
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    load: async <T>(entry: string): Promise<T> =>
      (await import(pathToFileURL(join(root, entry)).href)) as T,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
