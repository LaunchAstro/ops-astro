// SPDX-License-Identifier: AGPL-3.0-only
//
// MP-7-11: who the assistant talks about, and which models it may offer.
//
// **The subject is keyed by route and scope, never by address** (DOCK D-19).
// The mockup chose it from a legacy source path and, on an agency-wide page,
// fell back to its flagship client; here a page with no client or task in
// scope talks about that page and nothing else, so an agency-wide page never
// names one client.
//
// **A client's material offers no cloud model** (owner, 28 September 2026, line
// 72). A subject that carries a client, directly or through its task, is
// offered nothing unless that client's model-use setting (C60) says it is on;
// a setting this drawer could not read counts as off. The broker refuses the
// call on its own account (AW-01, C60); this is the drawer saying so first, in
// plain words, and sending nothing.

import type { AssistantModel, AssistantOffer } from '@launchastro/ui';
import { ROUTES, type RouteId } from '../routes.ts';

export type ModelChoice = AssistantModel;

export interface ScopeInput {
  readonly route: RouteId;
  readonly client: { readonly id: string; readonly name: string } | null;
  readonly task: {
    readonly id: string;
    readonly title: string;
    readonly clientId: string | null;
  } | null;
}

export interface Subject {
  readonly kind: 'page' | 'client' | 'task';
  readonly route: RouteId;
  readonly label: string;
  readonly placeholder: string;
  readonly chips: readonly string[];
  /** The client whose material this is, if any: the egress rule reads it. */
  readonly clientId: string | null;
}

export const LOCAL_MODEL_WAIT =
  'This client’s material waits on a local model, so nothing is sent to a cloud model.';

const CHIPS = {
  page: ["What's going on here?", 'What should I look at first?', 'What changed recently?'],
  client: [
    "What's going on with this client?",
    'What changed this week?',
    'What is waiting on us?',
  ],
  task: ["What's blocking this task?", 'What is the next step?', 'What changed on it?'],
} as const satisfies Record<Subject['kind'], readonly string[]>;

export function subjectFor(input: ScopeInput): Subject {
  const { route, client, task } = input;
  if (task !== null) {
    return {
      kind: 'task',
      route,
      label: task.title,
      placeholder: 'Ask about this task…',
      chips: CHIPS.task,
      clientId: task.clientId ?? client?.id ?? null,
    };
  }
  if (client !== null) {
    return {
      kind: 'client',
      route,
      label: client.name,
      placeholder: 'Ask about this client…',
      chips: CHIPS.client,
      clientId: client.id,
    };
  }
  return {
    kind: 'page',
    route,
    label: ROUTES[route].title,
    placeholder: 'Ask about this page…',
    chips: CHIPS.page,
    clientId: null,
  };
}

/** The models this subject may be asked through; none, in words, for client material. */
export function modelOffer(
  subject: Subject,
  catalogue: readonly ModelChoice[],
  clientModelUse: boolean | null,
): AssistantOffer {
  if (subject.clientId !== null && clientModelUse !== true) {
    return { models: [], waiting: LOCAL_MODEL_WAIT };
  }
  return { models: catalogue, waiting: null };
}
