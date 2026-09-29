// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines-per-function -- each backend is one object of its operations */
//
// The two backends the tracker conformance run drives (API-5): the upstream
// local-Markdown tracker, done exactly as `issue-tracker-local.md` says
// (files under a scratch directory), and Ops Astro, done only through the
// verb CLI lines `docs/agents/issue-tracker-ops-astro.md` documents. The run
// sends both the same wayfinding operations and compares what each holds.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Caller } from './api-3-world.ts';
import { idOf } from './api-3-world.ts';
import { madeIds } from './api-5-tracker.ts';

export interface NewTicket {
  readonly title: string;
  readonly type: string;
}

/** What a backend holds for the map, by title. */
export interface Outcome {
  readonly destination: string;
  readonly notes: string;
  readonly fog: readonly string[];
  /** `<ticket title>: <gist>`, in closing order. */
  readonly decisions: readonly string[];
  readonly open: readonly string[];
  readonly resolved: readonly string[];
}

/** At once (the files) or later (the CLI). */
type Later<T> = T | Promise<T>;

export interface Backend {
  chart(title: string, destination: string, notes: string, fog: readonly string[]): Later<void>;
  ticket(ticket: NewTicket): Later<string>;
  block(ticket: string, blockers: readonly string[]): Later<void>;
  /** The frontier's titles, first in map order. */
  frontier(): Later<readonly string[]>;
  claim(ticket: string): Later<void>;
  resolve(ticket: string, answer: string, gist: string): Later<void>;
  graduate(fog: string, tickets: readonly NewTicket[]): Later<readonly string[]>;
  outcome(): Later<Outcome>;
}

/** The body lines of a `## ` section of a Markdown text. */
const sectionLines = (text: string, heading: string): string[] => {
  const lines = text.split('\n');
  const start = lines.indexOf(`## ${heading}`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).filter((line) => line.trim() !== '');
};

/** `issue-tracker-local.md`: `.scratch/<effort>/map.md` and one file per ticket. */
/** The value of a `Key: value` line of a ticket file. */
const line = (text: string, key: string): string | undefined =>
  text
    .split('\n')
    .find((one) => one.startsWith(`${key}: `))
    ?.slice(key.length + 2);
/** A ticket file's title, its first line. */
const titleOf = (text: string): string => (text.split('\n')[0] as string).slice(2);

export function localBackend(root: string): Backend {
  const effort = join(root, '.scratch', 'conformance');
  const issues = join(effort, 'issues');
  const mapFile = join(effort, 'map.md');
  const files = (): string[] => readdirSync(issues).toSorted();
  const fileOf = (nn: string): string =>
    join(issues, files().find((f) => f.startsWith(`${nn}-`)) as string);
  const status = (nn: string): string | undefined =>
    line(readFileSync(fileOf(nn), 'utf8'), 'Status');
  const setStatus = (nn: string, value: string): void => {
    const lines = readFileSync(fileOf(nn), 'utf8')
      .split('\n')
      .filter((one) => !one.startsWith('Status: '));
    lines.splice(2, 0, `Status: ${value}`);
    writeFileSync(fileOf(nn), lines.join('\n'));
  };
  const editMap = (heading: string, edit: (body: string[]) => string[]): void => {
    const text = readFileSync(mapFile, 'utf8');
    const lines = text.split('\n');
    const start = lines.indexOf(`## ${heading}`);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((one) => one.startsWith('## '));
    const body = sectionLines(text, heading);
    const after = end === -1 ? [] : rest.slice(end);
    writeFileSync(
      mapFile,
      [...lines.slice(0, start + 1), '', ...edit(body), '', ...after].join('\n'),
    );
  };
  const backend: Backend = {
    chart(_title, destination, notes, fog) {
      mkdirSync(issues, { recursive: true });
      const body = [
        '## Destination',
        '',
        destination,
        '',
        '## Notes',
        '',
        notes,
        '',
        '## Decisions so far',
        '',
        '## Not yet specified',
        '',
        ...fog.map((f) => `- ${f}`),
        '',
        '## Out of scope',
        '',
      ];
      writeFileSync(mapFile, body.join('\n'));
    },
    ticket({ title, type }) {
      const nn = String(files().length + 1).padStart(2, '0');
      const slug = title.toLowerCase().replaceAll(/[^a-z0-9]+/gu, '-');
      const text = [`# ${title}`, '', `Type: ${type}`, '', '## Question', '', title, ''];
      writeFileSync(join(issues, `${nn}-${slug}.md`), text.join('\n'));
      return nn;
    },
    block(ticket, blockers) {
      const lines = readFileSync(fileOf(ticket), 'utf8').split('\n');
      lines.splice(1, 0, `Blocked by: ${blockers.join(', ')}`);
      writeFileSync(fileOf(ticket), lines.join('\n'));
    },
    frontier() {
      const open: string[] = [];
      for (const file of files()) {
        const nn = file.slice(0, 2);
        const text = readFileSync(join(issues, file), 'utf8');
        const blockers = (line(text, 'Blocked by') ?? '').split(', ').filter((b) => b !== '');
        const state = status(nn);
        if (state === 'resolved' || state === 'claimed') continue;
        if (blockers.every((blocker) => status(blocker) === 'resolved')) open.push(titleOf(text));
      }
      return open;
    },
    claim(ticket) {
      setStatus(ticket, 'claimed');
    },
    resolve(ticket, answer, gist) {
      writeFileSync(
        fileOf(ticket),
        `${readFileSync(fileOf(ticket), 'utf8')}\n## Answer\n\n${answer}\n`,
      );
      setStatus(ticket, 'resolved');
      const title = titleOf(readFileSync(fileOf(ticket), 'utf8'));
      const link = `issues/${fileOf(ticket).split('/').at(-1) as string}`;
      editMap('Decisions so far', (body) => [...body, `- [${title}](${link}): ${gist}`]);
    },
    graduate(fog, tickets) {
      editMap('Not yet specified', (body) => body.filter((one) => one !== `- ${fog}`));
      const made: string[] = [];
      for (const ticket of tickets) made.push(backend.ticket(ticket) as string);
      return made;
    },
    outcome() {
      const text = readFileSync(mapFile, 'utf8');
      const titles = files().map((file) => [
        file.slice(0, 2),
        titleOf(readFileSync(join(issues, file), 'utf8')),
      ]);
      return {
        destination: sectionLines(text, 'Destination').join(' '),
        notes: sectionLines(text, 'Notes').join(' '),
        fog: sectionLines(text, 'Not yet specified').map((one) => one.slice(2)),
        decisions: sectionLines(text, 'Decisions so far').map((one) =>
          one.replace(/^- \[(.+)\]\([^)]+\): (.+)$/u, '$1: $2'),
        ),
        open: titles
          .filter(([nn]) => status(nn as string) !== 'resolved')
          .map(([, t]) => t as string),
        resolved: titles
          .filter(([nn]) => status(nn as string) === 'resolved')
          .map(([, t]) => t as string),
      };
    },
  };
  return backend;
}

interface MapView {
  readonly revision: number;
  readonly destination: { readonly text: string } | null;
  readonly notes: { readonly text: string } | null;
  readonly fog: readonly { readonly id: string; readonly text: string }[];
  readonly decisions: readonly {
    readonly ticketId: string;
    readonly title: string;
    readonly gist: string;
  }[];
  readonly tickets: readonly {
    readonly id: string;
    readonly title: string;
    readonly revision: number;
  }[];
}

/** Ops Astro, through the verb CLI lines the tracker file documents, and nothing else. */
export function opsAstroBackend(cli: Caller): Backend {
  let map = '';
  const run = async (...argv: string[]): Promise<string> => {
    const answer = await cli.run(...argv);
    if (answer.exit !== 0) throw new Error(`${argv.slice(0, 2).join(' ')}: ${answer.out}`);
    return answer.out;
  };
  const view = async (): Promise<MapView> =>
    JSON.parse(await run('map', 'view', map, '--json')) as MapView;
  const revisionOf = async (id: string): Promise<string> =>
    String((await view()).tickets.find((t) => t.id === id)?.revision);
  const backend: Backend = {
    async chart(title, destination, notes, fog) {
      const out = await run(
        'map',
        'chart',
        '--title',
        title,
        '--destination',
        destination,
        '--notes',
        notes,
        '--fog',
        JSON.stringify(fog),
      );
      map = idOf({ exit: 0, out });
    },
    async ticket({ title, type }) {
      return idOf({
        exit: 0,
        out: await run('task', 'create', '--parent', map, '--type', type, '--title', title),
      });
    },
    async block(ticket, blockers) {
      await run(
        'task',
        'link',
        ticket,
        '--revision',
        await revisionOf(ticket),
        '--blocked-by',
        blockers.join(','),
      );
    },
    async frontier() {
      const out = JSON.parse(await run('map', 'frontier', map, '--json')) as {
        frontier: readonly { title: string }[];
      };
      return out.frontier.map((ticket) => ticket.title);
    },
    async claim(ticket) {
      await run('task', 'claim', ticket, '--revision', await revisionOf(ticket));
    },
    async resolve(ticket, answer, gist) {
      await run(
        'task',
        'resolve',
        ticket,
        '--revision',
        await revisionOf(ticket),
        '--answer',
        answer,
        '--gist',
        gist,
      );
    },
    async graduate(fog, tickets) {
      const current = await view();
      const patch = current.fog.find((one) => one.text === fog)?.id as string;
      const out = await run(
        'map',
        'graduate',
        map,
        '--revision',
        String(current.revision),
        '--patch',
        patch,
        '--tickets',
        JSON.stringify(tickets),
      );
      return Object.values(madeIds(out));
    },
    async outcome() {
      const current = await view();
      const closed = new Set(current.decisions.map((one) => one.ticketId));
      return {
        destination: current.destination?.text ?? '',
        notes: current.notes?.text ?? '',
        fog: current.fog.map((one) => one.text),
        decisions: current.decisions.map((one) => `${one.title}: ${one.gist}`),
        open: current.tickets.filter((t) => !closed.has(t.id)).map((t) => t.title),
        resolved: current.tickets.filter((t) => closed.has(t.id)).map((t) => t.title),
      };
    },
  };
  return backend;
}
