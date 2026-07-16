*How Pino's code is organized into packages, and which spec each one
realizes. The root of the implementation specs: this file is the package map;
the per-module specs (`transport.md`, `gateway.md`) sit alongside it. It
defines no contracts of its own — each package's contract lives in the
top-level spec it realizes.*

# Implementation

Authoritative for the package decomposition: which package realizes each
spec. It owns no message shapes or behavior rules — those belong to the
contracts. [[index.md]] owns the conceptual model (components as processes,
wires, principles); the specs in this folder own the physical realization in
code.

Two decompositions coexist and should not be conflated. **Components** are
runtime processes that speak schemas ([[index.md]]). **Packages** are units
of source. A component is realized by a package; shared substrate is realized
by packages that are not components at all.

## Packages

`transport` and `storage` are shared **libraries** — sets of functions the
components call. `gateway` is a **component**: a process, realized by its
package.

- **`transport`** — the wire library, realizing [[design/transport.md]]: NDJSON
  framing, the JSON-RPC connection, the `initialize` handshake, the
  inbound-request lifecycle, error types. Every component depends on it. What
  it provides is listed in [[implementation/transport.md]]; the exported API
  is read from the code.
- **`storage`** — the functions that manage the state directory, the run
  directory, descriptor files, and the singleton claim, realizing
  [[storage.md]]. A serving component depends on it; a pure client does not.
  Its surface is thin and [[storage.md]] suffices — no separate module spec.
- **`gateway`** — the inference provider component, realizing
  [[implementation/gateway.md]] and serving [[inference.md]]: the `pi-ai`
  wrapping, the credential store, the catalog, and the inference-schema
  method handlers. Depends on `transport` and `storage`.

A component package never depends on another component package — that is the
[[index.md]] principle at the package level: components compose over wires,
never by import. Sharing a library that realizes a cross-cutting spec
(`transport`, `storage`) is not that coupling — the binding contract is still
the spec, which a component in another language reimplements rather than
importing.
