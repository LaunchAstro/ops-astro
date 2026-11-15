// SPDX-License-Identifier: AGPL-3.0-only
//
// Docs, the agent path (#2519, #2493 piece 3): the agent CLI files a folder and a page and saves a
// new version, one verb per docs command, and an agent may reach each inside its delegation. An
// agent names the task it works under with `--task`, which the server authorises on that task by
// the agent's delegation; a person's line names none. The CLI holds no rule of its own: each verb
// only shapes the body its command takes. Database-free.

import { describe, expect, it } from 'vitest';
import { prepare, type Prepared } from '../../apps/cli/verbs.ts';
import { writeLine } from '../../apps/cli/render.ts';
import { COMMAND_SURFACE } from '../../packages/core-wire/src/surface.ts';

const ready = (argv: readonly string[]): Prepared => {
  const prepared = prepare(argv, true);
  if (!('row' in prepared)) throw new Error(`usage refused: ${prepared.out}`);
  return prepared;
};

const sent = (argv: readonly string[]) => {
  const { row, request } = ready(argv);
  const { operationId, ...body } = request;
  expect(typeof operationId, argv.join(' ')).toBe('string');
  return { command: row.command, body };
};

describe('the agent CLI files docs', () => {
  it('docs folder sends docs.create_folder with its name, and its parent when named', () => {
    expect(sent(['docs', 'folder', '--name', 'Handbook'])).toStrictEqual({
      command: 'docs.create_folder',
      body: { name: 'Handbook' },
    });
    expect(sent(['docs', 'folder', '--name', 'Onboarding', '--parent', 'F-1'])).toStrictEqual({
      command: 'docs.create_folder',
      body: { name: 'Onboarding', parentId: 'F-1' },
    });
    expect(sent(['docs', 'folder', '--name', 'Notes', '--task', 'T-1'])).toStrictEqual({
      command: 'docs.create_folder',
      body: { name: 'Notes', taskId: 'T-1' },
    });
  });

  it('docs page sends docs.create_page with its folder, title and Markdown text', () => {
    expect(
      sent(['docs', 'page', '--folder', 'F-1', '--title', 'First week', '--text', '# Hi']),
    ).toStrictEqual({
      command: 'docs.create_page',
      body: { folderId: 'F-1', title: 'First week', body: '# Hi' },
    });
    expect(
      sent(['docs', 'page', '--folder', 'F-1', '--title', 'Note', '--text', 'x', '--task', 'T-1']),
    ).toStrictEqual({
      command: 'docs.create_page',
      body: { folderId: 'F-1', title: 'Note', body: 'x', taskId: 'T-1' },
    });
  });

  it('docs update sends docs.update_page with the version it read, as a number', () => {
    expect(sent(['docs', 'update', 'P-1', '--version', '2', '--text', 'Revised'])).toStrictEqual({
      command: 'docs.update_page',
      body: { pageId: 'P-1', expectedVersion: 2, body: 'Revised' },
    });
    expect(sent(['docs', 'update', 'P-1', '--version', '2', '--title', 'Renamed'])).toStrictEqual({
      command: 'docs.update_page',
      body: { pageId: 'P-1', expectedVersion: 2, title: 'Renamed' },
    });
    expect(
      sent(['docs', 'update', 'P-1', '--version', '3', '--text', 'Again', '--task', 'T-1']),
    ).toStrictEqual({
      command: 'docs.update_page',
      body: { pageId: 'P-1', expectedVersion: 3, body: 'Again', taskId: 'T-1' },
    });
  });
});

describe('the agent CLI refuses and prints docs lines', () => {
  it('a docs line missing what its command needs is a usage refusal that sends nothing', () => {
    for (const argv of [
      ['docs', 'folder'],
      ['docs', 'page', '--folder', 'F-1', '--title', 'T'],
      ['docs', 'update', 'P-1', '--text', 'no version'],
    ]) {
      const prepared = prepare(argv, true);
      expect('row' in prepared, argv.join(' ')).toBe(false);
      expect('exit' in prepared ? prepared.exit : 0, argv.join(' ')).toBe(2);
    }
  });

  it('each docs write is one an agent may make inside its delegation', () => {
    for (const name of ['docs.create_folder', 'docs.create_page', 'docs.update_page']) {
      expect(COMMAND_SURFACE.find((each) => each.name === name)?.agent, name).toBe('delegated');
    }
  });

  it('a docs write prints the folder or page it made, and the version, since it names no record', () => {
    expect(
      writeLine('docs.create_folder', {
        recordId: null,
        revision: null,
        detail: { folderId: 'F-9' },
      }),
    ).toBe('ok docs.create_folder folderId F-9');
    expect(
      writeLine('docs.update_page', { recordId: null, detail: { pageId: 'P-1', version: 3 } }),
    ).toBe('ok docs.update_page pageId P-1 version 3');
  });
});
