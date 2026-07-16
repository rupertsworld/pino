*Glossary: every invented or specialized term, defined here. This file is
the authority for terminology; other specs use these terms and elaborate
behavior, but the definitions live here.*

# Terms

- *component* — a separately-running part of the system, composing with
  others only by messages. The components are enumerated in [[index.md]].
- *cli* — the minimal stdin/stdout client component.
- *descriptor* — the file a serving process writes to advertise its
  endpoint (lifecycle and fields: [[storage.md]]).
- *gateway* — the inference provider component: fronts model providers and
  owns credentials.
- *message* — one JSON object on one line of a connection (framing:
  [[transport.md]]).
- *notification* — a message with no `id`; never replied to.
- *request* / *response* — an id-carrying message and its matched answer.
- *run directory* — the directory of ephemeral facts about running
  processes (layout: [[storage.md]]).
- *runner* — the component that runs one live session.
- *schema* — the message contract of one component boundary.
- *session* — the durable object: an identity plus its log.
- *stale* — of a descriptor: its process is dead; anyone may delete it.
- *state directory* — the root of all Pino state on disk (layout:
  [[storage.md]]).
- *surface* — a client component or external program through which a user
  interacts with a session (the cli is one; a GUI or messaging bridge would
  be others).
- *wire* — a component boundary carrying messages; each wire is governed by
  one schema.
