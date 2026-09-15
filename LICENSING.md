# Licensing

The project is licensed under **AGPL-3.0-only**. [LICENSE](LICENSE) contains
the full GNU Affero General Public License, version 3. This repository does
not grant the "or any later version" option. The licence text governs the
rights and conditions; this page records the project's intended structure.

Legal review remains outstanding. The exception, contributor agreement,
trade-mark policy, and questions about AI-assisted authorship have not received
a legal opinion. Draft status must remain visible until the relevant review
and release decisions are complete.

## Current and proposed terms

| File                                           | Status                                                        |
| ---------------------------------------------- | ------------------------------------------------------------- |
| [LICENSE](LICENSE)                             | AGPL-3.0 licence text; project notices specify version 3 only |
| [NOTICE](NOTICE)                               | Maintainer attribution and third-party notices                |
| [LICENSE-EXCEPTIONS.md](LICENSE-EXCEPTIONS.md) | Draft preset and skill exception, not granted                 |
| [CLA.md](CLA.md)                               | Draft contributor licence agreement, not active               |
| [TRADEMARK.md](TRADEMARK.md)                   | Project name policy, subject to counsel                       |

The intended exception covers published preset formats, a separate skill
protocol, the REST API, and a future SDK. It does not cover the core itself.
It is not granted, and no current work may rely on it.

The CLA is a licence grant rather than a copyright assignment. Its intended
relicensing permission must be resolved and the signing process made active
before the first outside contribution merges. Outside contributions remain
closed. No signing service is claimed installed.

Nathan Mulligan is the named copyright holder and draft CLA counterparty.
Any later assignment to a legal entity requires its own documented action.
This foundation does not establish or perform such an assignment.

## Package boundaries

The core remains AGPL-3.0-only. A future SDK is intended to use Apache-2.0 for
wire types, schemas, and the client. No such SDK exists yet. Presets are
planned as declarative data with no executable code or schema changes.
[The preset boundary](docs/licensing/preset-boundary.md) states the technical
contract; its legal effect remains subject to the draft exception.

Vendored development skills retain their upstream MIT licences and notices.
[NOTICE](NOTICE) lists those files and their local modifications.
[SPDX conventions](docs/licensing/spdx-headers.md) apply to project source.

Langfuse is selected as an optional external diagnostic service. The exact
release, distribution, OSS and enterprise boundaries, and notices require
review before deployment. This foundation includes no Langfuse service and
makes no claim that an inspected deployment excludes enterprise code.
