// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent CLI's small general command set (API-3, CS-15.18, CS-15.19):
// `task get|list|create|update|link|comment|resolve` and `map view|frontier`,
// each one row mapping its words onto the owning command. The CLI holds no
// rule of its own: it builds the owning command's body, posts it once through
// `createCli` and prints what came back, compactly (`render.ts`). A refusal is
// the server's. *Map status*, *work this ticket* (`context`) and *changes*
// join with API-4's reads; the wayfinder tracker's writes (API-5) with
// `tracker-verbs.ts`.

import { randomUUID } from 'node:crypto';
import { createCli, isRefusal, type CliOptions } from './client.ts';
import { pageText, refusalLine, select, text, writeLine } from './render.ts';
import { COMMAND_SURFACE, type CommandName } from '../../packages/core-wire/src/index.ts';
import { TRACKER_VERBS, UNAVAILABLE_VERBS } from './tracker-verbs.ts';
import {
  detail,
  fields,
  idList,
  maybe,
  need,
  optional,
  revision,
  target,
  UsageError,
  type Body,
  type Flags,
  type VerbRow,
} from './verb-args.ts';

export type { VerbRow } from './verb-args.ts';

export interface VerbAnswer {
  readonly exit: number;
  readonly out: string;
}

const EXIT = { ok: 0, refused: 1, usage: 2, transport: 3, fault: 4 } as const;
const SWITCHES = new Set(['json']);

export const VERB_TABLE: readonly VerbRow[] = [
  {
    verb: 'task get',
    command: 'task.read',
    usage: '<id> [--detail brief|standard|full] [--fields a,b] [--json]',
    body: (id, flags) => ({ recordId: target(id), detail: detail(flags) }),
  },
  {
    verb: 'task list',
    command: 'task.board',
    usage: '[--board <id>] [--limit n] [--page <next>] [--detail ...] [--fields a,b] [--json]',
    body: (_id, flags) => {
      const limit = maybe(flags, 'limit');
      return {
        board: maybe(flags, 'board') ?? null,
        detail: detail(flags),
        ...(limit === undefined ? {} : { limit: Number(limit) }),
        ...optional('page', maybe(flags, 'page')),
      };
    },
  },
  {
    verb: 'task create',
    command: 'task.create',
    usage: '--title <t> [--description <d>] [--parent <id>] [--board <id>] [--type <type>]',
    body: (_id, flags) => ({
      fields: { ...fields(flags), title: need(flags, 'title') },
      ...optional('parentId', maybe(flags, 'parent')),
      ...optional('board', maybe(flags, 'board')),
      ...optional('taskType', maybe(flags, 'type')),
    }),
  },
  {
    verb: 'task update',
    command: 'task.update',
    usage: '<id> --revision n [--title <t>] [--description <d>]',
    body: (id, flags) => ({
      recordId: target(id),
      expectedRevision: revision(flags),
      fields: fields(flags),
    }),
  },
  {
    verb: 'task link',
    command: 'task.set_blocking',
    usage: '<id> --revision n --blocked-by <id,id> (the whole list; empty clears)',
    body: (id, flags) => ({
      recordId: target(id),
      expectedRevision: revision(flags),
      blockedBy: idList(flags, 'blocked-by'),
    }),
  },
  {
    verb: 'task comment',
    command: 'task.comment',
    usage: '<id> --revision n --text <t> [--audience internal|client]',
    body: (id, flags) => ({
      recordId: target(id),
      expectedRevision: revision(flags),
      body: need(flags, 'text'),
      audience: maybe(flags, 'audience') ?? 'internal',
    }),
  },
  {
    verb: 'task resolve',
    command: 'task.resolve',
    usage: '<id> --revision n --answer <a> --gist <one line>',
    body: (id, flags) => ({
      recordId: target(id),
      expectedRevision: revision(flags),
      answer: need(flags, 'answer'),
      gist: need(flags, 'gist'),
    }),
  },
  {
    verb: 'task context',
    command: 'task.context',
    usage: '<id> [--detail brief|standard|full] [--fields a,b] [--json] (work this ticket)',
    body: (id, flags) => ({ recordId: target(id), detail: detail(flags) }),
  },
  {
    verb: 'map view',
    command: 'map.view',
    usage: '<id> [--fields a,b] [--json]',
    body: (id) => ({ recordId: target(id) }),
  },
  {
    verb: 'map status',
    command: 'map.status',
    usage: '<id> [--detail brief|standard|full] [--fields a,b] [--json]',
    body: (id, flags) => ({ recordId: target(id), detail: detail(flags) }),
  },
  {
    verb: 'map frontier',
    command: 'map.frontier',
    usage: '<id> [--fields a,b] [--json]',
    body: (id) => ({ recordId: target(id) }),
  },
  ...TRACKER_VERBS,
];

/** The whole help, as an agent loads it: one line per verb. */
export function verbHelp(): string {
  return [
    'pnpm cli <verb> [args]. Writes print "ok <command> <id> r<revision>"; pass that revision',
    'to the next write. Refusals print one line; exit 0 ok, 1 refused, 2 usage, 3 no answer, 4 fault.',
    ...[...VERB_TABLE, ...UNAVAILABLE_VERBS].map((row) => `  ${row.verb} ${row.usage}`),
  ].join('\n');
}

function parse(argv: readonly string[]): { words: string[]; flags: Flags } {
  const words: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let at = 0; at < argv.length; at += 1) {
    const argument = argv[at] as string;
    if (!argument.startsWith('--')) words.push(argument);
    else if (SWITCHES.has(argument.slice(2))) flags[argument.slice(2)] = true;
    else {
      const value = argv[(at += 1)];
      if (value === undefined) throw new UsageError(`${argument} needs a value`);
      flags[argument.slice(2)] = value;
    }
  }
  return { words, flags };
}

const isWrite = (command: CommandName): boolean =>
  COMMAND_SURFACE.some((row) => row.name === command && row.kind === 'write');
const keyOf = (command: CommandName): string => {
  const row = COMMAND_SURFACE.find((one) => one.name === command);
  return row === undefined ? '' : `${row.collection}:${row.action}`;
};

/**
 * The agent prefix answers a read as its command handle, the read's own answer
 * under `detail` (`agentAnswer`); the person prefix answers it flat. One shape
 * out of both, so a person and an agent read the same lines.
 */
function unwrap(body: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const inner = body['detail'];
  return typeof inner === 'object' && inner !== null && 'command' in body
    ? (inner as Readonly<Record<string, unknown>>)
    : body;
}

function shape(row: VerbRow, answered: Readonly<Record<string, unknown>>, flags: Flags): string {
  const body = isWrite(row.command) ? answered : unwrap(answered);
  const picked = maybe(flags, 'fields')?.split(',');
  const asJson = flags['json'] === true;
  if (isWrite(row.command)) {
    if (asJson) return JSON.stringify(body);
    const made = body['detail'];
    const more = typeof made === 'object' && made !== null ? (row.more?.(made as Body) ?? '') : '';
    return `${writeLine(row.command, body)}${more === '' ? '' : ` ${more}`}`;
  }
  if (Array.isArray(body['page'])) {
    const items = (body['page'] as Readonly<Record<string, unknown>>[]).map((item) =>
      select(item, picked),
    );
    const next = typeof body['next'] === 'string' ? body['next'] : null;
    return asJson
      ? JSON.stringify({ items, ...(next === null ? {} : { next }) })
      : pageText(items, next);
  }
  const { ok: _ok, detail: _detail, ...rest } = body;
  const inner = Object.values(rest).length === 1 ? Object.values(rest)[0] : rest;
  const view = select(inner as Readonly<Record<string, unknown>>, picked);
  return asJson ? JSON.stringify(view) : text(view);
}

export function createVerbCli(options: CliOptions): {
  readonly run: (argv: readonly string[]) => Promise<VerbAnswer>;
} {
  const cli = createCli(options);
  const agent = options.entry === 'agent';
  return {
    run: async (argv) => {
      let row: VerbRow | undefined;
      let request: Body;
      let flags: Flags;
      try {
        const parsed = parse(argv);
        flags = parsed.flags;
        const [group = 'help', verb, id, ...extra] = parsed.words;
        if (group === 'help') return { exit: EXIT.ok, out: verbHelp() };
        // An operation with no home yet answers so here, with nothing sent.
        const unavailable = UNAVAILABLE_VERBS.find((one) => one.verb === `${group} ${verb ?? ''}`);
        if (unavailable !== undefined) return { exit: EXIT.refused, out: unavailable.answer };
        row = VERB_TABLE.find((one) => one.verb === `${group} ${verb ?? ''}`);
        if (row === undefined) throw new UsageError(`no verb ${group} ${verb ?? ''}; run help`);
        if (extra.length > 0) throw new UsageError(`unexpected ${extra[0] as string}`);
        request = row.body(id, flags);
      } catch (cause) {
        if (!(cause instanceof UsageError)) throw cause;
        return { exit: EXIT.usage, out: `usage: ${cause.message}` };
      }
      const operationId = isWrite(row.command) || agent ? { operationId: randomUUID() } : {};
      let answer;
      try {
        answer = await cli.run(row.command, { ...operationId, ...request });
      } catch (cause) {
        return { exit: EXIT.transport, out: `no answer: ${(cause as Error).message}` };
      }
      const body = (answer.body ?? {}) as Readonly<Record<string, unknown>>;
      if (isRefusal(answer))
        return { exit: EXIT.refused, out: refusalLine(body, keyOf(row.command)) };
      if (answer.status < 200 || answer.status >= 300 || answer.body === undefined) {
        return { exit: EXIT.fault, out: `fault ${String(answer.status)}` };
      }
      return { exit: EXIT.ok, out: shape(row, body, flags) };
    },
  };
}
