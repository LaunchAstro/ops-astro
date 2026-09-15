# Product identity

The `name` in [product.json](../product.json) is the current public product name.
Use it for product titles, navigation and other branded output when the first
application components are built. There is no application UI in this foundation.

To rename the product, edit that value and run `corepack pnpm brand:sync`.
The command updates the first lines of README.md and NOTICE. It preserves their
remaining content, including copyright and third-party notices. Run
`corepack pnpm check`; the check fails if those headings differ from the metadata.
Use neutral project wording in other documentation so a display-name change
stays small.

The package identity `@launchastro/hub`, `HUB_*` tooling variables, module paths
and future persisted identifiers are technical contracts. Keep them independent
of the display name. A branding change must not require a data migration or a
rewrite of permission, API or storage identifiers.

Repository ownership, copyright holders, contact addresses and deployment URLs
are separate records. A new name changes none of them automatically. Configure
website and API origins explicitly when deployment is authorised; never derive
a domain or assume its extension from the product name.
