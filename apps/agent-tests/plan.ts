// SPDX-License-Identifier: AGPL-3.0-only
//
// The agent tests on the owner's ChatGPT plan (#1626 R12), on the M5 only. A
// set runs there only when the owner started it: one start line, written by
// hand beside the plan's token file as
// `{"set":"<set>","date":"<today, YYYY-MM-DD>"}`, a file of the owner's own
// that nobody else can read. It is used once: the run takes it away before it
// starts. With no fitting line, or in CI, the command refuses before custody
// starts, and writes and sends nothing.
//
// Each turn is written as the plan's agent turn (`chatgptPlanTurnAdapter`),
// on the set's own plan model, offering `task.read` only, and handed to
// custody, which holds the plan's token, presents it to
// `https://api.openai.com` and folds the answer. Nothing here opens the token
// file. The plan's usage limit ends a case waiting on the plan's allowance.

import { closeSync, constants, fstatSync, mkdtempSync, openSync, readFileSync } from 'node:fs';
import { rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHATGPT_PLAN_ANSWER_BYTES,
  CHATGPT_PLAN_ISSUER,
  CHATGPT_PLAN_ORIGIN,
  CHATGPT_PLAN_PROVIDER,
  CHATGPT_PLAN_TIMEOUT_MS,
  chatgptPlanTurnAdapter,
  readChatgptPlanTurnAnswer,
} from '../../packages/core-connectors/src/index.ts';
import { startCustody, type ProcessCustody } from '../../packages/core-custody/src/agent.ts';
import { runCases, type Ask, type CaseSet, type Results } from './harness.ts';

/** The tools a case offers: the catalogue's names, as the broker hands the adapter them. */
const TOOLS = JSON.stringify(['task.read']);

/** The longest start line read; one the owner writes is far shorter. */
const START_LINE_BYTES = 256;

type PlanCustody = Pick<ProcessCustody, 'prepare' | 'dispatch'>;

const parsed = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

/** One turn on the plan, through custody, on `model`: never sent when the adapter wrote no input. */
const planAsk =
  (custody: PlanCustody, model: string): Ask =>
  async (_one, _turn, messages) => {
    const built = chatgptPlanTurnAdapter({ turn: JSON.stringify(messages), tools: TOOLS });
    const ask = JSON.parse(built.body) as { readonly input: readonly unknown[] };
    if (ask.input.length === 0) return { stopped: 'TURN_MALFORMED', recorded: false };
    const ready = await custody.prepare();
    if (!ready.ok) return { stopped: 'CUSTODY_NOT_ADMITTED', recorded: false };
    const outcome = await custody.dispatch(CHATGPT_PLAN_PROVIDER, {
      destination: CHATGPT_PLAN_PROVIDER,
      path: built.path,
      method: built.method,
      // The adapter's body, keys in their order, on the set's model.
      body: JSON.stringify({ ...ask, model }),
      timeoutMs: CHATGPT_PLAN_TIMEOUT_MS,
      maxResponseBytes: CHATGPT_PLAN_ANSWER_BYTES,
    });
    if (outcome.kind === 'refused') return { stopped: 'CUSTODY_NOT_ADMITTED', recorded: false };
    if (outcome.kind === 'answered' && !outcome.outbound.ok && outcome.outbound.status === 429) {
      return { stopped: 'LOCAL_PLAN_LIMIT', recorded: true };
    }
    const read =
      outcome.kind === 'answered' && outcome.outbound.ok
        ? readChatgptPlanTurnAnswer(parsed(outcome.outbound.body))
        : undefined;
    if (read === undefined) return { stopped: 'ANSWER_LOST', recorded: false };
    return {
      model: read.model,
      text: read.text,
      toolCalls: read.toolCalls ?? [],
      usage: read.usage,
    };
  };

/** A set's cases the plan can give, each turn through `custody`. */
export async function runPlanSet(set: CaseSet, custody: PlanCustody): Promise<Results> {
  const cases = set.cases.filter((one) => one.fakeOnly !== true);
  return await runCases(set, 'chatgpt_plan', cases, planAsk(custody, set.planModel));
}

const two = (n: number): string => String(n).padStart(2, '0');

/** Today on this machine's clock, as the owner writes it. */
function today(): string {
  const now = new Date();
  return `${String(now.getFullYear())}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

/** The start line's words, read without following a link: undefined unless it is the owner's own. */
function ownersLine(file: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    const own = stat.isFile() && stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
    return own && stat.size <= START_LINE_BYTES ? readFileSync(fd, 'utf8') : undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether the owner started this run of `set`: a fitting start line, taken
 * away so it starts one run only. A refusal says why and leaves the line.
 */
export function ownerStarted(home: string, set: string): string | undefined {
  const file = join(home, '.ops-astro', 'agent-tests-start.json');
  const text = ownersLine(file);
  if (text === undefined) return 'the owner has not started this run: no start line of theirs';
  const line = parsed(text);
  const fits =
    typeof line === 'object' &&
    line !== null &&
    Object.keys(line).toSorted().join() === 'date,set' &&
    (line as Record<string, unknown>)['set'] === set &&
    (line as Record<string, unknown>)['date'] === today();
  if (!fits) return `the owner has not started this run: the start line is not for ${set} today`;
  try {
    unlinkSync(file);
  } catch {
    return 'the owner has not started this run: the start line was already used';
  }
  return undefined;
}

/** A set on the owner's plan: custody started on the plan's token file and origin, then stopped. */
export async function runOnPlan(set: CaseSet, home: string): Promise<Results> {
  const scratch = mkdtempSync(join(tmpdir(), 'agent-tests-custody-'));
  try {
    // Custody files no credential for the plan; its token is the plan holder's.
    const credentialsFile = join(scratch, 'credentials.json');
    writeFileSync(credentialsFile, '[]', { mode: 0o600 });
    const custody = await startCustody({
      credentialsFile,
      destinations: [{ key: CHATGPT_PLAN_PROVIDER, origin: CHATGPT_PLAN_ORIGIN }],
      plan: {
        tokenFile: join(home, '.ops-astro', 'chatgpt-plan.json'),
        issuer: CHATGPT_PLAN_ISSUER,
      },
    });
    try {
      return await runPlanSet(set, custody);
    } finally {
      await custody.stop();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
