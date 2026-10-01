// SPDX-License-Identifier: AGPL-3.0-only
//
// The credential broker, as the API's composition root configures it (AW-01).
//
// Four settings, all or none. None is a deployment with no broker, and
// `model.call` answers that the part it rests on has not landed. Some of
// them, or a malformed one, stops the server with a problem naming the
// setting and never its value: a destination or a route can carry a host
// the operator would not want in a log.
//
// The operations and their adapters are registered here in code and
// reviewed, never configured: the replay provider is the only one until the
// real-provider run (AW-RP).
//
// One more setting picks the provider per install (LA-1, #859):
// `OPS_AGENT_PROVIDER` unset or `api` is the broker exactly as above;
// `local-claude` adds the owner's own subscription through the local runner,
// and is refused unless `OPS_ENVIRONMENT` is `local`. Under it the
// conversation operation's key answers with the local declaration, and the
// broker carries LA-1's local carve-out for unattended work on that route.

import {
  catalogue,
  CONVERSATION_ANSWER,
  LOCAL_CLAUDE_COMPOSE,
  LOCAL_CLAUDE_CONVERSATION,
  LOCAL_CLAUDE_PROVIDER,
  localClaudeAdapter,
  localClaudeCostMinor,
  REPLAY_COMPOSE,
  replayAdapter,
  replayCostMinor,
} from '../../packages/core-connectors/src/index.ts';
import {
  parseDestinations,
  startCustody,
  type BrokerRoute,
  type CredentialKind,
  type CustodyConfig,
  type Destination,
} from '../../packages/core-custody/src/index.ts';
import {
  conversationExchange,
  modelCallExecutor,
  type ConversationExchange,
  type ModelCallExecutor,
} from '../../packages/core-commands/src/index.ts';

export const MODEL_BROKER_SETTINGS = [
  'MODEL_BROKER_CREDENTIALS_FILE',
  'MODEL_BROKER_DESTINATIONS',
  'MODEL_BROKER_ROUTES',
  'MODEL_BROKER_INSTALLATION',
] as const;

/** Which provider this install's agent work runs on (LA-1). */
export const AGENT_PROVIDER_SETTING = 'OPS_AGENT_PROVIDER';
export type AgentProvider = 'api' | 'local-claude';

export type BrokerSettings =
  | { readonly kind: 'absent' }
  | {
      readonly kind: 'configured';
      readonly provider: AgentProvider;
      readonly custody: CustodyConfig;
      readonly routes: readonly BrokerRoute[];
      readonly installation: string;
    }
  | { readonly kind: 'invalid'; readonly problem: string };

const REPLAY = { build: replayAdapter, price: replayCostMinor };
const LOCAL_CLAUDE = { build: localClaudeAdapter, price: localClaudeCostMinor };

const OPERATIONS = {
  api: catalogue([REPLAY_COMPOSE, CONVERSATION_ANSWER]),
  'local-claude': catalogue([REPLAY_COMPOSE, LOCAL_CLAUDE_COMPOSE, LOCAL_CLAUDE_CONVERSATION]),
} as const;
const PROVIDERS = {
  api: new Map([['replay', REPLAY]]),
  'local-claude': new Map([
    ['replay', REPLAY],
    [LOCAL_CLAUDE_PROVIDER, LOCAL_CLAUDE],
  ]),
} as const;

const REACHES: ReadonlySet<string> = new Set(['local', 'cloud']);
const KINDS: ReadonlySet<string> = new Set<CredentialKind>([
  'subscription',
  'api_key',
  'cloud_credential',
  'replay',
]);
const ROUTE_TEXT = ['key', 'reach', 'provider', 'credentialRef', 'credentialKind', 'installation'];
const ROUTE_KEYS = [...ROUTE_TEXT, 'ceiling'];

const invalid = (problem: string): BrokerSettings => ({ kind: 'invalid', problem });

function parsedJson(text: string): { readonly ok: true; readonly value: unknown } | undefined {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}

function routeOf(entry: unknown, provider: AgentProvider): BrokerRoute | undefined {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const shape = entry as Record<string, unknown>;
  const keys = Object.keys(shape);
  if (keys.length !== ROUTE_KEYS.length || !ROUTE_KEYS.every((key) => keys.includes(key))) {
    return undefined;
  }
  // The route's ceiling across the installation (AW-01's fair share): a whole number of calls.
  const { ceiling } = shape;
  if (typeof ceiling !== 'number' || !Number.isSafeInteger(ceiling) || ceiling < 1) {
    return undefined;
  }
  if (!ROUTE_TEXT.every((key) => typeof shape[key] === 'string' && shape[key] !== '')) {
    return undefined;
  }
  const text = (key: string): string => shape[key] as string;
  if (!REACHES.has(text('reach')) || !KINDS.has(text('credentialKind'))) return undefined;
  if (!PROVIDERS[provider].has(text('provider'))) return undefined;
  return shape as unknown as BrokerRoute;
}

const LOCAL_WITHOUT_BROKER = `${AGENT_PROVIDER_SETTING} local-claude needs the credential broker's four settings`;

/** The install's provider, or why the setting is refused (never echoing its value). */
function agentProvider(
  environment: Readonly<Record<string, string | undefined>>,
): AgentProvider | { readonly problem: string } {
  const named = environment[AGENT_PROVIDER_SETTING] ?? '';
  if (named === '' || named === 'api') return 'api';
  if (named !== 'local-claude') {
    return { problem: `${AGENT_PROVIDER_SETTING} is not one of api, local-claude` };
  }
  if (environment['OPS_ENVIRONMENT'] !== 'local') {
    return {
      problem: `${AGENT_PROVIDER_SETTING} local-claude runs only where OPS_ENVIRONMENT is local`,
    };
  }
  return 'local-claude';
}

export function brokerSettings(
  environment: Readonly<Record<string, string | undefined>>,
): BrokerSettings {
  const provider = agentProvider(environment);
  if (typeof provider !== 'string') return invalid(provider.problem);
  const value = (name: (typeof MODEL_BROKER_SETTINGS)[number]): string => environment[name] ?? '';
  const missing = MODEL_BROKER_SETTINGS.filter((name) => value(name) === '');
  if (missing.length === MODEL_BROKER_SETTINGS.length) {
    return provider === 'api' ? { kind: 'absent' } : invalid(LOCAL_WITHOUT_BROKER);
  }
  if (missing.length > 0) {
    return invalid(`the credential broker needs all four settings; not set: ${missing.join(', ')}`);
  }

  const destinationsJson = parsedJson(value('MODEL_BROKER_DESTINATIONS'));
  const destinations =
    destinationsJson === undefined ? undefined : parseDestinations(destinationsJson.value);
  if (destinations === undefined || !destinations.ok) {
    return invalid(
      'MODEL_BROKER_DESTINATIONS is not a list of { key, origin } bare http(s) origins',
    );
  }

  const routesJson = parsedJson(value('MODEL_BROKER_ROUTES'));
  const entries = routesJson?.value;
  const routes = Array.isArray(entries)
    ? entries.map((entry: unknown) => routeOf(entry, provider))
    : undefined;
  if (routes === undefined || routes.length === 0 || routes.includes(undefined)) {
    return invalid(
      'MODEL_BROKER_ROUTES is not a list of routes, each exactly { key, reach, provider, ' +
        'credentialRef, credentialKind, installation, ceiling } with a known reach, kind and ' +
        'provider and a whole-number ceiling of at least 1',
    );
  }

  return {
    kind: 'configured',
    provider,
    custody: {
      credentialsFile: value('MODEL_BROKER_CREDENTIALS_FILE'),
      destinations: [...destinations.destinations.values()] as readonly Destination[],
    },
    routes: routes as readonly BrokerRoute[],
    installation: value('MODEL_BROKER_INSTALLATION'),
  };
}

/** Custody's own process, started, and the executor and the conversation exchange over it. */
export async function startModelBroker(
  settings: Extract<BrokerSettings, { kind: 'configured' }>,
): Promise<{
  readonly executor: ModelCallExecutor;
  readonly answerConversation: ConversationExchange;
  readonly stop: () => Promise<void>;
}> {
  const custody = await startCustody(settings.custody);
  const broker = {
    custody,
    operations: OPERATIONS[settings.provider],
    providers: PROVIDERS[settings.provider],
    routes: settings.routes,
    installation: settings.installation,
    localOwnerTesting: settings.provider === 'local-claude',
  };
  return {
    executor: modelCallExecutor(broker),
    answerConversation: conversationExchange(broker),
    stop: async () => await custody.stop(),
  };
}
