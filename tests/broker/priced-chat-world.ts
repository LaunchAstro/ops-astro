// SPDX-License-Identifier: AGPL-3.0-only
/* eslint-disable max-lines -- the stand-ins, custody, the broker and the reads the paid cases share */
//
// The paid chat cases' world: one business with its owner (listed for the
// outside paid model) and a colleague, the stand-in Ollama and the stand-in
// OpenRouter on loopback, and a broker over custody's real process that
// carries Ollama as the install's provider and OpenRouter as the outside one,
// with a made-up bearer key only custody holds. The exchange is the product's
// own (`conversationExchange`), so every case goes through the panel's path.
//
// The paid operation here reads the body custody hands the broker for
// OpenRouter, the stream already folded, and prices OpenRouter's reported US
// dollars at the fixed rate, rounded up to a whole cent.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import {
  catalogue,
  CONVERSATION_ANSWER,
  OLLAMA_CONVERSATION,
  ollamaAdapter,
  ollamaCostMinor,
  OPENROUTER_BODY_LIMIT,
  OPENROUTER_CONVERSATION,
  openrouterCostMinor,
  openrouterRequest,
  type ModelAnswer,
  type ModelOperationDeclaration,
} from '../../packages/core-connectors/src/index.ts';
import {
  conversationExchange,
  type ConversationExchange,
  type ConversationReply,
} from '../../packages/core-commands/src/index.ts';
import {
  callModelInConversation,
  startCustody,
  sweepModelCalls,
  type Broker,
  type ConversationCallRequest,
  type ModelCaller,
  type ModelCallResult,
  type PaidSeams,
  type ProviderAdapter,
} from '../../packages/core-custody/src/index.ts';
import { writeAuditEvent } from '../../packages/core-commands/src/commands/audit.ts';
import { digestOf } from './broker-world.ts';
import type { Database } from '../../packages/core-records/src/index.ts';
import { conversationWorld, detail, type ConversationWorld } from '../api/aw-03-fixture.ts';
import { composedWith } from '../api/aw-03-exchange-fixture.ts';
import { createApiFixture } from '../api/fixture.ts';
import { standInOllama, type StandIn } from '../api/ollama-stand-in-fixture.ts';
import {
  HAIKU,
  sse,
  standInOpenRouter,
  type OpenRouterStandIn,
} from '../api/openrouter-stand-in-fixture.ts';
import type { Member } from '../commands/fixture.ts';

export { HAIKU } from '../api/openrouter-stand-in-fixture.ts';

export const QWEN = 'qwen3.6:27b-mlx';
export const PAID_KEY = 'model.conversation_answer_openrouter';
/** The paid operation's most, in AUD cents. */
export const HOLD = 25;
/** The made-up key custody presents to the stand-in. */
export const BEARER: string = `or-test-${randomUUID()}`;

/** The folded body custody hands the broker, read as one answer; anything short of it is no answer. */
export function readFolded(body: unknown): ModelAnswer | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const shape = body as {
    readonly model?: unknown;
    readonly content?: unknown;
    readonly finish_reason?: unknown;
    readonly usage?: {
      readonly prompt_tokens?: unknown;
      readonly completion_tokens?: unknown;
      readonly cost?: unknown;
    };
    readonly error?: unknown;
  };
  const cost = shape.usage?.cost;
  if (shape.error !== null && shape.error !== undefined) return undefined;
  if (shape.finish_reason === 'error' || typeof shape.content !== 'string') return undefined;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return undefined;
  return {
    text: shape.content,
    model: typeof shape.model === 'string' ? shape.model : null,
    usage: {
      inputUnits: Number(shape.usage?.prompt_tokens ?? 0),
      outputUnits: Number(shape.usage?.completion_tokens ?? 0),
    },
    providerCode: null,
    reportedCost: { currency: 'USD', amount: cost },
  };
}

/** US dollars at AUD 1.60, in whole cents rounded up, worked in millionths. */
export const centsOf = (usd: number): number => Math.ceil((Math.round(usd * 1e6) * 160) / 1e6);

export const PAID: ModelOperationDeclaration = {
  key: PAID_KEY,
  provider: 'openrouter',
  destination: 'openrouter',
  fields: CONVERSATION_ANSWER.fields,
  answer: readFolded,
  timeoutMs: 20_000,
  maxResponseBytes: 512 * 1024,
  maximumMinor: HOLD,
  settlesAt: 'completed',
  nothingHappened: ['http_400', 'http_401', 'http_402', 'http_403', 'http_404'],
  billed: true,
  concurrency: 1,
};

/** The paid request as the case's adapter builds it: the model and the fields, as sent. */
export const paidAdapter: ProviderAdapter = {
  build: (values, _id, model) => ({
    path: '/api/v1/chat/completions',
    method: 'POST',
    body: JSON.stringify({ model, fields: values }),
  }),
  price: (answer: ModelAnswer): number => centsOf(answer.reportedCost?.amount ?? Number.NaN),
  bodyLimit: 48 * 1024,
};

/** OpenRouter's own adapter, as the API's catalogue registers it. */
export const OPENROUTER_ADAPTER: ProviderAdapter = {
  build: openrouterRequest,
  price: openrouterCostMinor,
  bodyLimit: OPENROUTER_BODY_LIMIT,
};

export interface Asked {
  readonly conversationId: string;
  readonly messageId: string;
}

export interface PricedWorld {
  readonly w: ConversationWorld;
  readonly ollama: StandIn;
  readonly openrouter: OpenRouterStandIn;
  readonly broker: Omit<Broker, 'audit'>;
  readonly exchange: ConversationExchange;
  /** The same deployment as a second API instance: its own custody process and exchange. */
  twin(
    change?: (broker: Omit<Broker, 'audit'>) => Omit<Broker, 'audit'>,
  ): Promise<ConversationExchange>;
  /** The broker asked directly, as the owner unless `caller` says otherwise, with live seams. */
  direct(
    request: Omit<ConversationCallRequest, 'operation'> & { readonly operation?: string },
    caller?: ModelCaller,
    change?: (broker: Omit<Broker, 'audit'>) => Omit<Broker, 'audit'>,
  ): Promise<ModelCallResult>;
  /** The owner's own call, as the broker sees its caller. */
  readonly owner: ModelCaller;
  /** The conversation's calls moved back past the sweep's age, then swept. */
  sweep(conversationId: string): Promise<void>;
  /** A conversation started by `member` on the paid model, and its first message. */
  question(body: string, member?: Member, extra?: Record<string, unknown>): Promise<Asked>;
  /** The same conversation's next message. */
  next(conversationId: string, body: string, member?: Member): Promise<Asked>;
  ask(asked: Asked, member?: Member, database?: Database): Promise<ConversationReply | null>;
  calls(conversationId: string): Promise<readonly Record<string, unknown>[]>;
  /** The business's committed amount under its chat budget, read as the hold reads it. */
  committed(businessId?: string): Promise<number>;
  setCap(limitMinor: number, businessId?: string): Promise<void>;
  stop(): Promise<void>;
}

/** The conversation as the broker is handed it, for a direct call. */
export const scopeOf = (
  p: PricedWorld,
  asked: Asked,
): Omit<ConversationCallRequest, 'operation'> => ({
  conversation: {
    id: asked.conversationId,
    businessId: p.w.fixture.business,
    ownerPersonId: p.w.owner.personId,
  },
  messageId: asked.messageId,
  fields: [{ name: 'message', source: 'outside' as const, value: 'What is due today?' }],
});

/** The conversation and message an applied start or message wrote. */
const asked = (answer: Awaited<ReturnType<ConversationWorld['as']>>): Asked => ({
  conversationId: String(detail(answer)['conversationId']),
  messageId: String(detail(answer)['messageId']),
});

/** Seams whose caller can no longer be resolved: no transaction is ever opened as them. */
// oxlint-disable-next-line unicorn/no-useless-undefined -- the seam answers undefined for that
export const noCaller: PaidSeams['asCaller'] = async () => await Promise.resolve(undefined);

/** The outside people setting, as `OPS_OUTSIDE_MODEL_PEOPLE` lists them. */
export const listed = (businessId: string, member: Member): string =>
  `${businessId}:${member.personId}`;

// oxlint-disable-next-line max-lines-per-function -- the stand-ins, custody, the broker and the reads
/**
 * `real`: OpenRouter's own declaration and adapter, its destination declaring the
 * stream custody decodes, and a stand-in that streams server-sent events.
 */
export async function pricedWorld(
  label: string,
  people: (businessId: string, owner: Member) => readonly string[] = (b, o) => [listed(b, o)],
  concurrency = 1,
  real = false,
): Promise<PricedWorld> {
  const fixture = await createApiFixture(label);
  const w = await conversationWorld({
    fixture,
    api: composedWith(fixture, async () => await Promise.resolve(null)),
  });
  const outsidePeople = people(fixture.business, w.owner);
  vi.stubEnv('OPS_AGENT_PROVIDER', 'ollama');
  vi.stubEnv('OPS_OUTSIDE_PROVIDER', 'openrouter');
  vi.stubEnv('OPS_OUTSIDE_MODEL_PEOPLE', outsidePeople.join(','));
  const ollama = await standInOllama();
  const openrouter = await standInOpenRouter();
  const folder = mkdtempSync(join(tmpdir(), 'priced-chat-'));
  const credentialsFile = join(folder, 'credentials.json');
  writeFileSync(
    credentialsFile,
    JSON.stringify([
      {
        ref: 'ollama_key',
        kind: 'api_key',
        account: 'm5-ollama',
        destination: 'ollama',
        header: 'authorization',
        value: `local-${randomUUID()}`,
      },
      {
        ref: 'openrouter',
        kind: 'api_key',
        account: 'agency-astro-openrouter',
        destination: 'openrouter',
        header: 'authorization',
        scheme: 'bearer',
        value: BEARER,
      },
    ]),
    { mode: 0o600 },
  );
  const custodyConfig = {
    credentialsFile,
    destinations: [
      { key: 'ollama', origin: ollama.origin },
      real
        ? { key: 'openrouter', origin: openrouter.origin, stream: 'openai_sse' as const }
        : { key: 'openrouter', origin: openrouter.origin },
    ],
  };
  if (real) {
    openrouter.answer = (request) => ({
      status: 200,
      chunks: sse(String(request.body['model']), ['Two tasks ', 'are due ', 'today.']),
    });
  }
  const custody = await startCustody(custodyConfig);
  const twins: { stop(): Promise<void> }[] = [];
  const broker: Omit<Broker, 'audit'> = {
    custody,
    operations: catalogue([
      OLLAMA_CONVERSATION,
      { ...(real ? OPENROUTER_CONVERSATION : PAID), concurrency },
    ]),
    providers: new Map<string, ProviderAdapter>([
      ['ollama', { build: ollamaAdapter, price: ollamaCostMinor }],
      ['openrouter', real ? OPENROUTER_ADAPTER : paidAdapter],
    ]),
    routes: [
      {
        key: 'm5_ollama',
        reach: 'local',
        provider: 'ollama',
        credentialRef: 'ollama_key',
        credentialKind: 'api_key',
        installation: 'here',
        ceiling: 4,
      },
      {
        key: 'openrouter',
        reach: 'cloud',
        provider: 'openrouter',
        credentialRef: 'openrouter',
        credentialKind: 'api_key',
        installation: 'here',
        ceiling: concurrency,
      },
    ],
    installation: 'here',
    outsidePeople,
  };
  const exchange = conversationExchange(broker);
  const { db, business } = fixture;
  const owner: ModelCaller = {
    actorId: w.owner.actorId,
    delegationId: null,
    attendedByPersonId: w.owner.personId,
  };
  const audit: Broker['audit'] = async (tx, note) => {
    await writeAuditEvent(tx, {
      actorId: w.owner.actorId,
      command: note.action,
      outcome: note.outcome,
      refusalCode: note.refusalCode,
      payloadDigest: digestOf(note.detail),
      attempted: note.outcome === 'refused' ? note.detail : null,
    });
  };
  /** Seams as the exchange gives them, minus the session: the business's own transaction. */
  const seams = (authors: readonly string[]): PaidSeams => ({
    authors,
    asCaller: async (work) =>
      await db.app.withBusiness(
        business,
        async (tx) =>
          await work(tx, {
            stillAdmitted: async () => await Promise.resolve(true),
            keep: async () => await Promise.resolve(true),
          }),
      ),
  });
  return {
    w,
    ollama,
    openrouter,
    broker,
    exchange,
    owner,
    twin: async (change = (same) => same) => {
      const other = await startCustody(custodyConfig);
      twins.push(other);
      return conversationExchange(change({ ...broker, custody: other }));
    },
    direct: async (request, caller = owner, change = (same) => same) =>
      await callModelInConversation(
        db.app,
        business,
        caller,
        {
          operation: PAID_KEY,
          model: HAIKU,
          paid: seams([caller.actorId]),
          ...request,
        },
        { ...change(broker), audit },
      ),
    sweep: async (conversationId) => {
      await db.admin.execute(
        `update public.model_calls
            set accepted_at = accepted_at - interval '1 hour',
                started_at = started_at - interval '1 hour'
          where conversation_id = $1 and state = 'dispatched'`,
        [conversationId],
      );
      await db.app.withBusiness(business, async (tx) => {
        await sweepModelCalls(tx);
      });
    },
    question: async (body, member = w.owner, extra = {}) =>
      asked(await w.as(member, 'conversation.start', { body, model: HAIKU, ...extra })),
    next: async (conversationId, body, member = w.owner) =>
      asked(await w.as(member, 'conversation.message', { conversationId, body })),
    ask: async (question, member = w.owner, database = db.app) =>
      await exchange(database, business, member.presented, question),
    calls: async (conversationId) =>
      await db.admin.execute(
        `select * from public.model_calls where conversation_id = $1 order by started_at`,
        [conversationId],
      ),
    committed: async (businessId = business) => {
      const [row] = await db.admin.execute<{ readonly committed: string }>(
        `select coalesce(sum(case when m.state = 'settled' then m.actual_minor
                                  when m.state in ('reserved', 'dispatched', 'liability_unknown')
                                    then m.reserved_minor else 0 end), 0)::text as committed
           from public.model_calls m
           join public.planning_envelopes e
             on e.business_id = m.business_id and e.id = m.planning_envelope_id
          where m.business_id = $1`,
        [businessId],
      );
      return Number(row?.committed ?? 0);
    },
    setCap: async (limitMinor, businessId = business) => {
      await db.admin.execute(
        `insert into public.budget_caps (business_id, id, key, limit_minor, currency)
         values ($1, $2, 'planning', $3, 'AUD')
         on conflict (business_id, key) do update set limit_minor = excluded.limit_minor`,
        [businessId, randomUUID(), limitMinor],
      );
    },
    stop: async () => {
      ollama.open();
      openrouter.open();
      await custody.stop();
      for (const twin of twins) {
        // oxlint-disable-next-line no-await-in-loop -- each twin's custody, in turn
        await twin.stop();
      }
      await ollama.close();
      await openrouter.close();
      rmSync(folder, { recursive: true, force: true });
      await w.drop();
      vi.unstubAllEnvs();
    },
  };
}
