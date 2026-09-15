# The preset boundary

**Subject to counsel.** This describes where the licence boundary is meant to
sit. The permission that would rest on it is a draft in
`LICENSE-EXCEPTIONS.md` and is not granted.

Nothing described here is built. This repository holds no product preset, executable product skill,
product wire protocol, or software development kit. Vendored development
skills are listed separately in NOTICE. The file
exists so the boundary is written down before anything crosses it.

## Why a boundary at all

The core is AGPL. Without a stated boundary, a preset author or a skill
author cannot tell whether their work becomes a covered work. That
uncertainty stops people from writing presets, which is the opposite of what
this project wants.

So the boundary is stated first, and the permission that follows it is
written second.

## The rule in one line

A preset is data. A skill is a separate process. These are intended technical boundaries. The draft exception has no legal
effect until it is approved and granted.

## Presets: data only

A preset describes a way of working: record types, field definitions, links,
views, gate definitions, labels, seeded rows.

Inside the boundary:

- Declarative data files in the published preset formats.
- Text, labels and copy in those files.
- Seed rows loaded through the ordinary loading path.

Outside the boundary, and not allowed in a preset at all:

- Executable code of any kind.
- Schema changes. No table creation, no column addition, no migration.
- Anything that reaches into the core's internals rather than its published
  formats.

This is a product rule before it is a licence rule. A preset that can run
code or change the schema is a security surface and a support burden. When a
preset exists, a check in continuous integration is meant to enforce the
rule. No preset exists, so no check does.

## Skills: separate processes

A skill runs as its own process and talks to the core over a versioned
message protocol. No core internal type appears on the wire. This separates execution and integration responsibilities. Whether that
boundary supports the intended legal exception remains for counsel.

## The kit

The intended route for preset and skill authors is a set of Apache-2.0
packages holding the wire types, the JSON schemas and the client. Authors
depend on those and never on an AGPL package. No such package exists today.

## What is not on the boundary

The core: the runtime, the records engine, the custody layer, the connectors
and the interface packages. Changing any of them and offering the result over
a network is exactly what section 13 of the AGPL is about. No exception is
intended to reach it.

## Open questions for counsel

- Whether the data-only rule survives contact with a preset expressive enough
  to be useful.
- Whether "no core internal type on the wire" is a strong enough line, or
  whether the protocol has to be versioned and published separately for the
  argument to hold.
- Whether the boundary needs to be described in the granted permission itself
  or can live in a document like this one that the permission points at.
