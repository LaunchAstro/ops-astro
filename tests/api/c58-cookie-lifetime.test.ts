// SPDX-License-Identifier: AGPL-3.0-only
//
// C58: the browser session cookie's lifetime.
//
// The cookie is S0-6's, and main sets none yet: the web client holds its
// bearer in the tab's session storage. When S0-6 lands, the cookie takes
// `SESSION_ABSOLUTE_SECONDS`, the one place the 12-hour limit is set, and this
// case is built against it.

import { it } from 'vitest';

it.todo(
  'C58 cookie lifetime: the browser session cookie carries the same 12-hour absolute limit, and a cookie one second past it is refused (LEANS-ON SL01 S0-6)',
);
