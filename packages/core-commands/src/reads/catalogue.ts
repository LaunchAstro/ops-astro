// SPDX-License-Identifier: AGPL-3.0-only
//
// The read catalogue: every fact about a read, on one row keyed by its name.
//
// The identifiers a read takes, whether it needs the task spine, how its
// authority is asked, whether an outsider is told NOT_FOUND, its operand
// check and what it serves are each a field of the read's row, and
// `reads/dispatch.ts` runs one pipeline over the row with no branch on the
// name. It is the read-path twin of the command
// catalogue (`core-wire/src/surface.ts`), and keyed by every read name, so a read
// added to the union is a type error here until someone says what it takes.
//
// The grant the read asks, collection and action, stays on its
// `COMMAND_SURFACE` row: that is what the route generator and the surface
// inventory read. This row says only how the check is asked.

import {
  clientsReached,
  isClientHere,
  planPresetSync,
  isUuid,
  listTags,
  readPreferences,
  subjectsOf,
  taskAccess,
} from '../../../core-records/src/index.ts';
import { readAlerts, readOutages, readTaskTrace } from '../../../core-runtime/src/index.ts';
import type { TenantQuery, Session, PresetField } from '../../../core-records/src/index.ts';
import {
  isCommandRefusal,
  refuseCommand,
  refuseNotFound,
  type CommandRefusal,
} from '../commands/refusal.ts';
import type { TaskSpine } from '../commands/context.ts';
import type { ReadOperands, ReadRequest, ReadResult } from './requests.ts';
import { isInternalReader, readSharedTask, readTaskDetail, resolveTaskId } from './tasks.ts';
import { readStateChoices } from './task-states.ts';
import { readMapFrontier, readMapView } from './maps.ts';
import { boardAdmission, boardOf, liveTask } from './board-admission.ts';
import { listPeople, listTeam, readAccess, readOwnName } from './people.ts';
import { readTodos } from './todos.ts';
import { readQueue } from './queue.ts';
import { readTaskExecution } from './execution.ts';
import { readAwaitingReview } from './awaiting-review.ts';
import { readPlanningCap } from '../../../core-custody/src/index.ts';
import { readSettings } from './settings.ts';
import { listCustodySecrets } from './custody.ts';
import { readConnectionFleet } from './connections.ts';
import { readConnectionSignal } from './signal.ts';
import { readConnectionGraduation } from './graduation.ts';
import { readCapabilities } from './capabilities.ts';
import { parseReceipt, receiptSubject, serveReceipt } from './receipts.ts';
import { listConversations, readConversation } from './conversation.ts';
import { readAllowance } from './allowance.ts';
import { DIGEST, readAttribution } from './attribution.ts';
import { SERVER_HIT_LIMIT, searchTasks, wordsOf } from './search.ts';
import { parseBreachNotices, readBreachNotices, readOperations } from './operations.ts';
import { countOwed, readInbox, readUnattendedInbox } from './inbox.ts';
import { readHarnessTrigger } from './harness-trigger.ts';
import { readAutomationRegistry } from './automations.ts';
import { invalid, isFieldMap } from '../commands/operands.ts';
import { readClientFacts } from '../commands/task-content.ts';
import { isKnownTimeZone, readLedger } from './ledger.ts';

export type ReadName = ReadRequest['read'];

/** One read's request, narrowed by name and still unchecked. */
export type ReadOf<K extends ReadName> = ReadRequest & { readonly read: K };

/** A read's body checked: its operands, or the refusal the body earned. */
export type Parsed<K extends ReadName> =
  | { readonly ok: true; readonly operands: ReadOperands[K] }
  | { readonly ok: false; readonly refusal: CommandRefusal };

/** What the pipeline found for a row that reads the spine, before it is served. */
export interface Found {
  readonly spine: TaskSpine;
  /** The one record the read is about, resolved; absent for a business read. */
  readonly recordId: string | undefined;
}

interface RowBase<K extends ReadName> {
  /**
   * The identifier fields the read takes (root ruling 3). Any other is refused
   * `COMMAND_BODY_INVALID`, as on the command path: a body whose identifier
   * the server quietly ignores is a body the caller believes was honoured, and
   * a read that ignored it cannot claim to have looked it up.
   */
  readonly identifiers: readonly string[];
  /**
   * The operands the read cannot be asked without, checked before any lookup
   * so an absent or mistyped one is a refusal and not a fault at a bound
   * parameter (checklist B7), and audited like every other refused read (I13).
   * What it hands back is all the row's later steps are given.
   */
  readonly parse: (body: Readonly<Record<string, unknown>>) => Parsed<K>;
  /**
   * How the grant check is asked. `declared`: the row's own collection and
   * action, at the subject's record scope or the business's. A function: the
   * collection it names instead. `holds-any-grant`: no collection is asked;
   * the read refuses a caller holding nothing (see `session.capabilities`).
   * `declared-within`: a list read. For an external party, as `declared`.
   * For a member, the row's `serve` decides from one read of their grants:
   * a business grant answers every record with the withheld count (B-22), a
   * grant on some records answers those and no count (a client login, owner
   * answer 22), no grant is refused.
   * `self`: no grant is asked; the answer is about the caller alone and names
   * nobody else (`session.person`), or serves the caller's own rows only and
   * derives access on each (the inbox).
   */
  readonly authority:
    | 'declared'
    | 'declared-within'
    | 'holds-any-grant'
    | 'self'
    | ((operands: ReadOperands[K]) => string);
  /**
   * Whether an external party refused by the grant check is told `NOT_FOUND`
   * rather than `SCOPE_NOT_GRANTED` (minimum contract 8.2 case 7: "Sibling
   * tasks and the board are NOT_FOUND"). `SCOPE_NOT_GRANTED` means "in this
   * business, exists, not yours", which is the fact an outsider must not learn
   * about a sibling. A member keeps the in-tenant code (I05).
   */
  readonly outsiderNotFound: boolean;
}

/**
 * A read that needs the installed task type's identifiers. The pipeline reads
 * them before the grant check, and `subject` and `serve` are handed them, so
 * neither has a missing spine to answer.
 */
export interface SpineRow<K extends ReadName> extends RowBase<K> {
  readonly spine: true;
  /**
   * The one record the read is about, resolved before the grant check and
   * never after it: a record-scoped grant is a grant on a record, not on
   * whichever spelling the caller used. Absent on a read about the business.
   */
  readonly subject?: (
    tx: TenantQuery,
    spine: TaskSpine,
    operands: ReadOperands[K],
  ) => Promise<string | undefined>;
  /**
   * The row's own gate, asked after the grant and before `serve`: false is
   * `NOT_FOUND`. It is apart from `serve` so a check that shows the person
   * nothing can ask it without serving (`admitRead`).
   */
  readonly admits?: (tx: TenantQuery, session: Session, found: Found) => Promise<boolean>;
  /**
   * A list read's admission (`declared-within`), which its `serve` decides
   * from the read of the caller's grants: the refusal `serve` would answer,
   * or none. Apart from `serve` so `admitRead` refuses what the read refuses
   * without serving it.
   */
  readonly listRefusal?: (
    tx: TenantQuery,
    session: Session,
    operands: ReadOperands[K],
    found: Found,
  ) => Promise<CommandRefusal | undefined>;
  readonly serve: (
    tx: TenantQuery,
    session: Session,
    operands: ReadOperands[K],
    found: Found,
  ) => Promise<ReadResult | CommandRefusal>;
}

/** A read about the business that needs no spine and names no record. */
export interface BusinessRow<K extends ReadName> extends RowBase<K> {
  readonly spine: false;
  readonly serve: (
    tx: TenantQuery,
    session: Session,
    operands: ReadOperands[K],
  ) => Promise<ReadResult | CommandRefusal>;
}

export type ReadRow<K extends ReadName> = SpineRow<K> | BusinessRow<K>;

/**
 * An array of field maps. That is all a read checks of a preset's fields: the
 * keys each one carries are the planner's to refuse, in its own words, so the
 * narrowing to `PresetField` is the wire's promise and not this check's. It is
 * made once, here, so `serve` hands the planner its own type without a cast.
 */
function isFieldList(value: unknown): value is readonly PresetField[] {
  return Array.isArray(value) && value.every(isFieldMap);
}

/** A body refused on one operand, in the command path's words (`commands/operands.ts`). */
function rejected(
  name: string,
  fix: string,
): { readonly ok: false; readonly refusal: CommandRefusal } {
  return { ok: false, refusal: invalid(name, fix) };
}

function parsed<T>(operands: T): { readonly ok: true; readonly operands: T } {
  return { ok: true, operands };
}

const NONE = (): { readonly ok: true; readonly operands: Readonly<Record<never, never>> } =>
  parsed({});

/** The longest query a search takes, which is longer than anything typed into ⌘K. */
const QUERY_LENGTH = 200;
const QUERY_FIX = `Send query as up to ${String(QUERY_LENGTH)} characters with a word in them.`;

/** A search's words: a string no longer than the limit, with a word in it. */
const isQuery = (query: unknown): query is string =>
  typeof query === 'string' && query.length <= QUERY_LENGTH && wordsOf(query).length > 0;

/**
 * A zone name as the zone database spells one: letters, digits and `_+-`, in
 * `/`-separated parts. The shape keeps anything else from reaching the
 * lookup; whether the server knows the zone is `serve`'s question.
 */
const ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]{0,31}(?:\/[A-Za-z0-9_+-]{1,32}){0,2}$/u;
const ZONE_FIX = 'Send timeZone as a zone name the server knows, such as Australia/Brisbane.';
const BEFORE_FIX = 'Send before as a day, YYYY-MM-DD, or leave it out for the newest days.';

/** A real day from 1970 on, written `YYYY-MM-DD`: no time, no other shape. */
function isCalendarDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^(19[7-9]\d|[2-9]\d{3})-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const day = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

/** The planner reads each preset field as an object; which keys it needs is its own question. */
const PRESET_FIELDS_FIX = 'Send fields as an array of field objects, which may be empty.';

/**
 * `session.capabilities` for a caller holding no live grant, in the words
 * `checkAuthority` uses for any operation no grant covers: it is the same
 * refusal, reached by a read with no collection of its own to ask about.
 */
const NO_GRANT_AT_ALL = refuseCommand(
  'SCOPE_NOT_GRANTED',
  [],
  ['no live grant covers it', 'ask a holder who may delegate'],
);

/**
 * `task.todos`'s scope (MP-7-2): none, one teammate or one client, each a
 * well-formed identifier. A malformed one is refused rather than read as no
 * scope, which would answer the reader's own list to a question about someone
 * else's.
 */
function parseTodoScope({
  person,
  client,
}: Readonly<Record<string, unknown>>): Parsed<'task.todos'> {
  if (person !== undefined && client !== undefined) {
    return rejected('client', 'Send a person or a client, not both.');
  }
  if (person !== undefined && !(typeof person === 'string' && isUuid(person))) {
    return rejected('person', 'Send person as a teammate’s person identifier.');
  }
  if (client !== undefined && !(typeof client === 'string' && isUuid(client))) {
    return rejected('client', 'Send client as the client’s identifier.');
  }
  return parsed({
    ...(typeof person === 'string' ? { person: person.toLowerCase() } : {}),
    ...(typeof client === 'string' ? { client: client.toLowerCase() } : {}),
  });
}

/** A live task that is not a map is named as one; anything else is not there. */
async function notAMap(tx: TenantQuery, recordId: string): Promise<CommandRefusal> {
  const live = await tx.query<{ readonly type: string | null }>(
    `select data ->> 'type' as type from public.records
      where business_id = $1 and id = $2 and deleted_at is null`,
    [tx.businessId, recordId],
  );
  if (live[0] === undefined || live[0].type === 'map') return refuseNotFound();
  return refuseCommand(
    'FIELD_VALUE_INVALID',
    ['recordId'],
    ['That task is not a map. Read it with task.read.'],
  );
}

export const READ_CATALOGUE: { readonly [K in ReadName]: ReadRow<K> } = {
  'map.view': {
    identifiers: ['recordId'],
    parse: ({ recordId }) =>
      typeof recordId === 'string'
        ? parsed({ recordId })
        : rejected('recordId', 'Send recordId as the map’s identifier or its key.'),
    spine: true,
    subject: (tx, spine, operands) => resolveTaskId(tx, spine.taskTypeId, operands.recordId),
    authority: 'declared',
    outsiderNotFound: true,
    async serve(tx, session, _operands, { spine, recordId }) {
      // A map never reaches a client surface (WF-1).
      if (recordId === undefined || !isInternalReader(session.roleKey)) return refuseNotFound();
      const map = await readMapView(tx, spine.taskTypeId, recordId, subjectsOf(session));
      return map === undefined ? await notAMap(tx, recordId) : { ok: true, map };
    },
  },
  'map.frontier': {
    identifiers: ['recordId'],
    parse: ({ recordId }) =>
      typeof recordId === 'string'
        ? parsed({ recordId })
        : rejected('recordId', 'Send recordId as the map’s identifier or its key.'),
    spine: true,
    subject: (tx, spine, operands) => resolveTaskId(tx, spine.taskTypeId, operands.recordId),
    authority: 'declared',
    outsiderNotFound: true,
    async serve(tx, session, _operands, { spine, recordId }) {
      if (recordId === undefined || !isInternalReader(session.roleKey)) return refuseNotFound();
      const answer = await readMapFrontier(tx, spine.taskTypeId, recordId);
      return answer ?? (await notAMap(tx, recordId));
    },
  },
  // AW-03. No collection is asked at the door: the owner reads their own
  // without the read-any grant, so the rule is the read's own
  // (`reads/conversation.ts`), and a caller holding nothing is refused there.
  'conversation.read': {
    identifiers: ['conversationId'],
    // Any body parses: a caller holding nothing is refused SCOPE_NOT_GRANTED
    // before the identifier is looked at (the matrix's case (e)), so the
    // read checks the identifier itself, after that.
    parse: ({ conversationId }) => parsed({ conversationId }),
    spine: false,
    authority: 'holds-any-grant',
    // The door asks no grant, so this flag has nothing to answer; the read
    // itself tells a caller with no membership NOT_FOUND.
    outsiderNotFound: false,
    serve: async (tx, session, { conversationId }) =>
      await readConversation(tx, session, conversationId),
  },
  // MP-7-11. The caller's own conversations; the rule is the read's own, as
  // `conversation.read`'s is, because the owner lists without the read-any
  // grant and the read-any grant lists nothing.
  'conversation.list': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    serve: async (tx, session) => await listConversations(tx, session),
  },
  // AW-04 (U10): the drawer's allowance line. The rule is the read's own, as
  // the list's is: the team's, holding `conversation:write`; the conversation
  // is optional (an empty drawer has none yet) and must be the caller's own.
  'conversation.allowance': {
    identifiers: ['conversationId'],
    // Any body parses, so a caller holding nothing is refused before the
    // identifier is looked at, as `conversation.read` does.
    parse: ({ conversationId }) => parsed({ conversationId }),
    spine: false,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    serve: async (tx, session, { conversationId }) =>
      await readAllowance(tx, session, conversationId),
  },
  'task.read': {
    identifiers: ['recordId'],
    parse: ({ recordId }) =>
      typeof recordId === 'string'
        ? parsed({ recordId })
        : rejected('recordId', 'Send recordId as the task’s identifier or its key.'),
    spine: true,
    // The lookup answers nobody: a caller with no grant is refused after it
    // and learns nothing from it either way, and an unresolved name is checked
    // at business scope, so "there is no such task" is still answered by the
    // read and never by the authority check.
    subject: (tx, spine, operands) => resolveTaskId(tx, spine.taskTypeId, operands.recordId),
    authority: 'declared',
    outsiderNotFound: true,
    async serve(tx, session, _operands, { spine, recordId }) {
      if (recordId === undefined) return refuseNotFound();
      // Internal readers get the detail; everyone else, the external party
      // first among them, gets the shared view, which is built from the
      // catalogue's `shared` fields and never from the detail with parts cut.
      if (!isInternalReader(session.roleKey)) {
        const sharedTask = await readSharedTask(
          tx,
          spine.taskTypeId,
          recordId,
          spine.taskCommentTypeId,
        );
        return sharedTask === undefined ? refuseNotFound() : { ok: true, sharedTask };
      }
      // An agent credential's call stands as its person but is an agent's
      // (API-2, I09): it reads what the agent prefix reads, never as an
      // internal reader, its rank pool the one task, no one's time and no
      // Client field facts (catalogue #418).
      const agent = session.credentialScope !== undefined;
      const task = await readTaskDetail(
        tx,
        spine.taskTypeId,
        recordId,
        agent
          ? { commentTypeId: spine.taskCommentTypeId, internal: false }
          : { commentTypeId: spine.taskCommentTypeId, internal: true, actorId: session.actorId },
        // A member's rank pool is every open task their grants reach.
        agent ? { kind: 'task' } : { kind: 'grants', subjects: subjectsOf(session) },
        // A member reads their own time on the task (RS-VAULT-9).
        agent ? null : session.personId,
      );
      // Not there, or there in another business: one answer, deliberately.
      if (task === undefined) return refuseNotFound();
      // The Client field's facts (MP-4-8) go to a member alone: an agent's
      // detail and the shared view carry neither.
      return {
        ok: true,
        task: agent
          ? task
          : { ...task, ...(await readClientFacts(tx, task.id, subjectsOf(session))) },
        states: await readStateChoices(tx, spine.taskStateTypeId),
      };
    },
  },
  'task.board': {
    identifiers: ['board'],
    // `null` is a real board: the list of tasks on none. An absent key is
    // not, and answering it with that list gave a body that asked nothing
    // the answer to a question it never put. A string is
    // looked up, and refused `NOT_FOUND` there if it names nothing here.
    parse: ({ board }) =>
      typeof board === 'string' || board === null
        ? parsed({ board })
        : rejected(
            'board',
            'Send board as a board task’s identifier, or null for tasks on no board.',
          ),
    spine: true,
    authority: 'declared-within',
    outsiderNotFound: true,
    // Staff's alone, as the ledger is (A4-1, A4-3: fail closed): a board row
    // carries time, rank and comment counts, and anyone else reads a task's
    // shared view through `task.read`. Asked here, so `admitRead` refuses too.
    admits: async (_tx, session) => await Promise.resolve(isInternalReader(session.roleKey)),
    listRefusal: async (tx, session, operands, { spine }) => {
      const admitted = await boardAdmission(tx, session, operands.board, spine);
      return 'refusal' in admitted ? admitted.refusal : undefined;
    },
    async serve(tx, session, operands, { spine }) {
      const admitted = await boardAdmission(tx, session, operands.board, spine);
      if ('refusal' in admitted) return admitted.refusal;
      const { scope } = admitted;
      const { tasks, changedAt } = await boardOf(
        tx,
        session,
        spine.taskTypeId,
        operands.board,
        scope,
      );
      // The withheld count goes only to a member holding task:read on the
      // whole collection, whose grant reaches every task, so it is 0 until a
      // narrower collection-wide rule exists. A member reading through record
      // grants is a client login under owner answer 22 and is told no count
      // at all, not a filtered one (SL07-B22-ANSWER).
      // The stamp is the newest of the rows served, so it is in scope (MP-5-7).
      // `viewer` is the caller's own person, the one the viewer preset
      // narrows to (MP-5-12), and `owed` their own count as `inbox.count` gives it.
      const [viewer, owed] = [session.personId, await countOwed(tx, session.personId)];
      return scope.business
        ? { ok: true, tasks, changedAt, viewer, owed, withheld: 0 }
        : { ok: true, tasks, changedAt, viewer, owed };
    },
  },
  // The grant is asked by the search, not here: a record-scoped reader is
  // refused a business-scope check and still may search what they hold, so the
  // scopes they hold are what the statement is handed (`reads/search.ts`).
  'task.search': {
    identifiers: [],
    parse: ({ query }) => (isQuery(query) ? parsed({ query }) : rejected('query', QUERY_FIX)),
    spine: true,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    serve: async (tx, session, operands, { spine }) =>
      await searchTasks(tx, session, { taskTypeId: spine.taskTypeId, query: operands.query }),
  },
  // No subject record, for the reason `task.queue` gives: the ledger is about
  // every task the business has, and naming one would make "who read this
  // record" false for the rest.
  'task.ledger': {
    identifiers: [],
    parse({ before, timeZone, query }) {
      if (typeof timeZone !== 'string' || !ZONE_SHAPE.test(timeZone)) {
        return rejected('timeZone', ZONE_FIX);
      }
      if (before !== undefined && before !== null && !isCalendarDay(before)) {
        return rejected('before', BEFORE_FIX);
      }
      if (query !== undefined && query !== null && !isQuery(query)) {
        return rejected('query', QUERY_FIX);
      }
      return parsed({ before: before ?? null, timeZone, query: query ?? null });
    },
    spine: true,
    authority: 'declared',
    // An outsider standing on one shared task is not told the business keeps
    // a ledger of the rest (minimum contract 8.2 case 7, as for the board).
    outsiderNotFound: true,
    async serve(tx, session, operands, { spine }) {
      // Staff's alone: `task.read` shows anyone else a task's shared view,
      // which carries no history, and the ledger is nothing but history. The
      // answer is the outsider's, so it says nothing about what is kept.
      if (!isInternalReader(session.roleKey)) return refuseNotFound();
      if (!(await isKnownTimeZone(tx, operands.timeZone))) return invalid('timeZone', ZONE_FIX);
      // A search is C1's one service: the ledger reads the events of the tasks it
      // found, up to C1's bound (the server's, never the caller's), says when
      // more of the reader's own matches lie past it, and runs no second search.
      const found =
        operands.query === null
          ? null
          : await searchTasks(tx, session, {
              taskTypeId: spine.taskTypeId,
              query: operands.query,
              limit: SERVER_HIT_LIMIT,
            });
      if (found !== null && isCommandRefusal(found)) return found;
      const taskIds = found === null ? null : found.hits.map((hit) => hit.id);
      const page = await readLedger(tx, spine.taskTypeId, { ...operands, taskIds });
      return found === null
        ? { ok: true, ...page }
        : { ok: true, ...page, more: found.more === true };
    },
  },
  'person.list': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'declared',
    outsiderNotFound: false,
    serve: async (tx) => ({ ok: true, persons: await listPeople(tx) }),
  },
  // The vocabulary is the business's, asked at the business (`task:read`), so
  // a reader held to one client's records is refused rather than shown the
  // names every client's tasks carry.
  'tag.list': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'declared',
    outsiderNotFound: false,
    serve: async (tx) => ({ ok: true, tags: await listTags(tx) }),
  },
  // The reader's own to-dos (MP-7-1), asked at the business (`task:read`) like
  // the tag vocabulary: a reader held to one client's records is refused, and
  // the list is filtered by the reader's person inside the query. Scoped to a
  // teammate or a client (MP-7-2) under the same key, and no other: the key
  // already reaches every task in the business, so a scope narrows what the
  // reader may read and never widens it, and the reader held to some records
  // is refused before any person is looked up, told no count.
  'task.todos': {
    identifiers: ['person', 'client'],
    parse: parseTodoScope,
    spine: true,
    authority: 'declared',
    outsiderNotFound: false,
    async serve(tx, session, { person, client }, { spine }) {
      // A teammate is an active member here, the people `person.list` offers.
      // Another business's person, a former member and a made-up id are one
      // answer, and nothing is listed.
      if (
        person !== undefined &&
        !(await listPeople(tx)).some((each) => each.personId === person)
      ) {
        return refuseNotFound();
      }
      // A client is one of this business's; another business's and a made-up
      // id are one NOT_FOUND, never an empty list (minimum contract 8.2).
      if (client !== undefined && !(await isClientHere(tx, client))) return refuseNotFound();
      const scope = client === undefined ? { person: person ?? session.personId } : { client };
      return { ok: true, todos: await readTodos(tx, spine, scope) };
    },
  },
  // The Team panel (MP-7-10) is staff only: a client holding `person:read`
  // still meets NOT_FOUND, and the list names staff alone.
  'team.list': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'declared',
    outsiderNotFound: true,
    serve: async (tx, session) =>
      isInternalReader(session.roleKey)
        ? { ok: true, you: session.personId, people: await listTeam(tx) }
        : refuseNotFound(),
  },
  // No subject record: the queue is about the business's outstanding work
  // rather than about one task, and naming one of the tasks on it in the
  // audit row would make "who read this record" false for the others. The
  // alerts beside it are the team's (T2h): a reader outside it is shown none,
  // and an agent's queue (`agent-operations.ts`) carries none.
  'task.queue': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'declared',
    outsiderNotFound: false,
    serve: async (tx, session) => ({
      ok: true,
      queue: await readQueue(tx),
      alerts: isInternalReader(session.roleKey) ? await readAlerts(tx) : [],
      // T3e2: one report per outage, the team's as the alerts are.
      outages: isInternalReader(session.roleKey) ? await readOutages(tx) : [],
    }),
  },
  // The task's runs, after the grant at the task's record scope. It is
  // internal work: an external party is answered as for a task it cannot see,
  // whether or not a share lets it read the task itself.
  'task.execution': {
    identifiers: ['recordId'],
    parse({ recordId, cursor }) {
      if (typeof recordId !== 'string') {
        return rejected('recordId', 'Send recordId as the task’s identifier or its key.');
      }
      if (cursor === undefined) return parsed({ recordId, cursor: 0 });
      return Number.isSafeInteger(cursor) && Number(cursor) >= 0
        ? parsed({ recordId, cursor: Number(cursor) })
        : rejected('cursor', 'Send cursor as a whole number of at least 0, or leave it out.');
    },
    spine: true,
    subject: (tx, spine, operands) => resolveTaskId(tx, spine.taskTypeId, operands.recordId),
    authority: 'declared',
    outsiderNotFound: true,
    // Not there, in another business or trashed: one answer, as `task.read` gives.
    admits: async (tx, session, { spine, recordId }) =>
      recordId !== undefined &&
      isInternalReader(session.roleKey) &&
      (await liveTask(tx, spine.taskTypeId, recordId)),
    async serve(tx, _session, operands, { recordId }) {
      if (recordId === undefined) return refuseNotFound();
      return { ok: true, execution: await readTaskExecution(tx, recordId, operands.cursor) };
    },
  },
  // AW-04: the runs that read one file, by its digest, and what they reached.
  // Pre-review, the team's only, each run filtered by the caller's task `read`
  // inside the query (`reads/attribution.ts`). No subject record: a digest is
  // not one, and naming one run's task would make the audit row false for the
  // others. The door asks for any grant; the read refuses the rest itself.
  'definition.attribution': {
    identifiers: [],
    parse: ({ digest }) =>
      typeof digest === 'string' && DIGEST.test(digest)
        ? parsed({ digest })
        : rejected('digest', 'Send digest as the file’s sha-256, 64 lowercase hex characters.'),
    spine: true,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    async serve(tx, session, { digest }, { spine }) {
      const attribution = await readAttribution(tx, session, spine.taskTypeId, digest);
      return 'refused' in attribution ? attribution : { ok: true, attribution };
    },
  },
  // No subject record, as the queue: the list is about the gates the caller
  // may decide. The door asks for any grant; the rows are filtered by the
  // caller's `decide` inside the query, and a caller holding none is refused.
  'gate.pending': {
    identifiers: [],
    parse: NONE,
    spine: true,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    async serve(tx, session, _operands, { spine }) {
      const awaiting = await readAwaitingReview(tx, session, spine.taskTypeId, 'task');
      return Array.isArray(awaiting) ? { ok: true, awaiting } : (awaiting as CommandRefusal);
    },
  },
  'preset.plan': {
    identifiers: [],
    parse({ recordTypeKey, presetKey, fields }) {
      if (typeof recordTypeKey !== 'string' || recordTypeKey === '') {
        return rejected('recordTypeKey', 'Send recordTypeKey as a non-empty string.');
      }
      if (typeof presetKey !== 'string' || presetKey === '') {
        return rejected('presetKey', 'Send presetKey as a non-empty string.');
      }
      if (!isFieldList(fields)) return rejected('fields', PRESET_FIELDS_FIX);
      return parsed({ recordTypeKey, presetKey, fields });
    },
    spine: false,
    // The collection is the family the request names, because that is the
    // grant the plan actually needs: the planner's `planPresetSync` checks
    // `manage` on the family of `recordTypeKey`, so a blanket `manage` on
    // `preset` in front of it would be a wider question than the operation asks
    // and a caller holding only it would be let through here and refused there.
    // The declaration's own `preset` is what the route is about rather than
    // what it takes; see `CommandDeclaration.collection`.
    //
    // Today the record type key *is* the family (the planner's `familyOf`,
    // private to the planner because it is the one place a real
    // type-to-collection mapping has to land). This is the same key, not a
    // second copy of that mapping: should the two ever differ, the planner
    // still asks its own question afterwards, so this check can only be
    // redundant or narrower -- never wider than the authority the plan is
    // granted under.
    authority: (operands) => operands.recordTypeKey,
    outsiderNotFound: false,
    async serve(tx, session, operands) {
      // The planner checks the same authority again, from its own module, and
      // that repetition is deliberate: the guarantee "this plan was authorised"
      // belongs to the planner whichever surface reaches it, and the guarantee
      // "every operation is authorised before it runs" belongs here. Neither is
      // safe to delete on the strength of the other.
      const planned = await planPresetSync(
        tx,
        { personId: session.personId, actorId: session.actorId },
        {
          recordTypeKey: operands.recordTypeKey,
          presetKey: operands.presetKey,
          fields: operands.fields,
        },
      );
      if (!planned.ok) return planned.refusal;
      return { ok: true, plan: planned.value };
    },
  },
  // Asked per row by the scopes the caller holds `custody:manage` at (C31): a
  // caller holding it nowhere is refused inside the read, never shown an
  // empty list.
  'secret.list': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    serve: async (tx, session) => await listCustodySecrets(tx, session),
  },
  // By the scopes `connection:read` is held at; held nowhere is refused, not empty.
  'connection.fleet': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    serve: async (tx, session) => await readConnectionFleet(tx, session),
  },
  // Grants, tripwires and the night round, by the same scopes (MP-14-8).
  'connection.signal': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    serve: async (tx, session) => await readConnectionSignal(tx, session),
  },
  // Every client the caller's `connection:read` scopes reach at once, so the
  // scope bar asks nothing (MP-14-10a); held nowhere is refused, not empty.
  'connection.graduation': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    serve: async (tx, session) => await readConnectionGraduation(tx, session),
  },
  // No subject record, for the reason `task.queue` gives: the settings are
  // the business's own configuration rather than one record, and there is no
  // `settings` row in `records` to name in the column even if there were.
  'settings.read': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'declared',
    outsiderNotFound: false,
    // The planning cap beside the settings (AW-04): the business's own
    // configuration too, and every settings reader may see it; only
    // `billing:decide` moves it (`budget.set_planning_cap`).
    serve: async (tx) => ({
      ok: true,
      settings: await readSettings(tx),
      planningCap: await readPlanningCap(tx),
    }),
  },
  // `session.capabilities` has no collection of its own to hold a grant on:
  // it reports the caller's grants, so it is answered only to a caller who
  // holds at least one. A member with none is refused `SCOPE_NOT_GRANTED` like
  // every other operation (minimum contract 8.2 case 3, ledger I05), and never
  // answered with an empty list, because a denied read is not a success with
  // nothing in it. A login with no standing never arrives here at all: that is
  // `AUTH_NO_MEMBERSHIP` from the resolution, before any read runs. An
  // external party is shown its shares' pairs. The declaration keeps its
  // collection and action because the route generator and the surface
  // inventory read them, and a row missing half its shape would be a special case in
  // three more places.
  'session.capabilities': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    async serve(tx, session) {
      const capabilities = await readCapabilities(tx, session);
      if (capabilities.grants.length === 0) return NO_GRANT_AT_ALL;
      return { ok: true, ...capabilities };
    },
  },
  'task.receipt': {
    identifiers: ['attemptId'],
    parse: parseReceipt,
    spine: true,
    subject: receiptSubject,
    authority: 'declared',
    outsiderNotFound: true,
    serve: serveReceipt,
  },
  // The person menu's name (C23). Answered to anyone signed in, a member with
  // no grant and a client outside the business included, because it is only
  // ever their own: the statement reads the caller's own person row and takes
  // no operand that could name another.
  'session.person': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'self',
    outsiderNotFound: false,
    serve: async (tx, session) => ({
      ok: true,
      person: { name: await readOwnName(tx, session.personId) },
    }),
  },
  // The caller's own preferences (MP-2-11a): the query names the caller, so
  // nothing else is reachable. A caller holding no live grant is refused.
  'preference.read': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'self',
    outsiderNotFound: false,
    serve: async (tx, session) =>
      (await holdsAnyGrant(tx, session))
        ? { ok: true, preferences: await readPreferences(tx, session.personId) }
        : NO_GRANT_AT_ALL,
  },
  // Every person's authority, so it asks the key that changes it: `manage` on
  // `access`, which no agent holds. No subject record, as for `task.queue`.
  'access.read': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'declared',
    outsiderNotFound: false,
    serve: async (tx) => ({ ok: true, ...(await readAccess(tx)) }),
  },
  // C32. The clients the caller's live grants reach, asked inside the query:
  // every client for a business-wide grant of any key, one client for a grant
  // over it. No one collection is asked, and a caller holding nothing is
  // refused rather than shown an empty list.
  'client.list': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    async serve(tx, session) {
      const clients = await clientsReached(tx, subjectsOf(session));
      if (clients === null) return NO_GRANT_AT_ALL;
      return { ok: true, clients };
    },
  },
  // C55. The business's own operations, so no subject record; it asks
  // `read` on `operations`, which no agent holds. Its unattended items are
  // `inbox.unattended`'s, read for the same caller.
  'operations.read': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'declared',
    outsiderNotFound: false,
    serve: async (tx, session) => ({ ok: true, ...(await readOperations(tx, session.personId)) }),
  },
  // C81's breach drill. It asks `manage` on `privacy`, the key the incident is
  // recorded under, which no agent holds. The incident is looked up in the
  // business's own rows, so another business's id is NOT_FOUND like a made-up one.
  'privacy.draft_breach_notices': {
    identifiers: [],
    parse(body) {
      const operands = parseBreachNotices(body);
      return isCommandRefusal(operands) ? { ok: false, refusal: operands } : parsed(operands);
    },
    spine: false,
    authority: 'declared',
    outsiderNotFound: false,
    serve: async (tx, _session, operands) => await readBreachNotices(tx, operands),
  },
  // The caller's own items: the query names the caller as recipient and each
  // item's access is asked of their live grants, which is the permission
  // check (INB-1d). The count is the same read, counted. A caller holding no
  // live grant is refused, as `session.capabilities` refuses one, and never
  // answered with a list of withheld items or a zero.
  'inbox.read': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'self',
    outsiderNotFound: false,
    serve: async (tx, session) =>
      (await holdsAnyGrant(tx, session))
        ? { ok: true, inbox: await readInbox(tx, session.personId, subjectsOf(session)) }
        : NO_GRANT_AT_ALL,
  },
  'inbox.count': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'self',
    outsiderNotFound: false,
    serve: async (tx, session) =>
      (await holdsAnyGrant(tx, session))
        ? { ok: true, owed: await countOwed(tx, session.personId) }
        : NO_GRANT_AT_ALL,
  },
  // Every path to a person broken (INB-1e): `operations:read` on the business,
  // declared, and within it only the items whose task the caller reads.
  'inbox.unattended': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'declared',
    outsiderNotFound: false,
    serve: async (tx, session) => ({
      ok: true,
      unattended: await readUnattendedInbox(tx, session.personId),
    }),
  },
  // AW-13 readers: a task's runs' trace. `operations:read` (C55: the owner and
  // administrators by install default, never a member, never an agent) at the
  // task's record scope, then the task's own read, so another client's task is
  // NOT_FOUND like one that is not there.
  'trace.read': {
    identifiers: ['recordId'],
    parse: ({ recordId }) =>
      typeof recordId === 'string'
        ? parsed({ recordId })
        : rejected('recordId', 'Send recordId as the task’s identifier or its key.'),
    spine: true,
    subject: (tx, spine, operands) => resolveTaskId(tx, spine.taskTypeId, operands.recordId),
    authority: 'declared',
    outsiderNotFound: true,
    async serve(tx, session, _operands, { spine, recordId }) {
      if (
        recordId === undefined ||
        !isInternalReader(session.roleKey) ||
        !(await liveTask(tx, spine.taskTypeId, recordId)) ||
        (await taskAccess(tx, session.personId, recordId)) !== 'readable'
      ) {
        return refuseNotFound();
      }
      return { ok: true, trace: { taskId: recordId, ...(await readTaskTrace(tx, recordId)) } };
    },
  },
  // AW-12: the harness test's result on one run. No subject record and no
  // spine: the run names its task, and the read filters it by the caller's
  // task `read` inside its statement (`reads/harness-trigger.ts`), so the
  // door asks for any grant and the read refuses the rest itself.
  'harness.read': {
    identifiers: [],
    parse: ({ runId }) =>
      typeof runId === 'string'
        ? parsed({ runId })
        : rejected('runId', 'Send runId as the run’s identifier.'),
    spine: false,
    authority: 'holds-any-grant',
    outsiderNotFound: false,
    async serve(tx, session, { runId }) {
      const harness = await readHarnessTrigger(tx, session, runId);
      return 'refused' in harness ? harness : { ok: true, harness };
    },
  },
  // The business's definitions, versions and activations (C33): asked like
  // `settings.read`, at the business, since no row carries a client.
  'automation.registry': {
    identifiers: [],
    parse: NONE,
    spine: false,
    authority: 'declared',
    outsiderNotFound: false,
    serve: async (tx) => await readAutomationRegistry(tx),
  },
};

async function holdsAnyGrant(tx: TenantQuery, session: Session): Promise<boolean> {
  return (await readCapabilities(tx, session)).grants.length > 0;
}

/**
 * Whether a surface name is one of these reads. The catalogue holds exactly
 * the surface's reads (`tests/commands/read-authorised-on.test.ts`), so the
 * boundary narrows a route's name with this rather than casting its body.
 */
export function isReadName(name: string): name is ReadName {
  return Object.hasOwn(READ_CATALOGUE, name);
}
