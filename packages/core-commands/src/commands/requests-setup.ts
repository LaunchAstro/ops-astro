// SPDX-License-Identifier: AGPL-3.0-only
//
// One member of `CommandRequest`'s union for three request families, each in
// its own file: custody, the connector fleet and graduation (C31, MP-14-7a,
// MP-14-10a); workflow triggers and standing approvals (C33, C52-A); and new
// client onboarding (C41-A). Kept here so `requests.ts` stays under the
// per-file cap.

import type { AutomationRequest } from './automation-requests.ts';
import type { ConnectionsRequest } from './requests-connections.ts';
import type { OnboardingRequest } from './requests-onboarding.ts';

export type SetupRequest<Envelope> =
  ConnectionsRequest<Envelope> | (AutomationRequest & Envelope) | OnboardingRequest<Envelope>;
