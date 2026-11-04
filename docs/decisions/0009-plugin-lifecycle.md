# 0009 — Plugins have an explicit activate/deactivate lifecycle

Status: accepted (first recorded 2026-09-06 in `plans/adr/0004-own-kernel-vs-dsh.md`)

## Context

A plugin that reads configuration in its constructor cannot be validated,
refused, or torn down. If validation happens after the object exists, a plugin
whose config is wrong has already had a chance to run, and a plugin that holds
a connection has no place to release it.

## Decision

A plugin is a factory plus a lifecycle:

```ts
interface Plugin {
  activate(context: PluginContext): Promise<void>;
  deactivate(): Promise<void>;
}
```

- The kernel validates the manifest, checks grants, validates `config` against
  the manifest's declared shape, then calls `activate` with the
  capability-checked context.
- Nothing that performs I/O happens before `activate` resolves; nothing is
  assumed available after `deactivate` runs.
- Activation is refused rather than partially applied: a plugin that throws in
  `activate` is not registered, and a refused activation emits a reason.
- A plugin that performs no I/O may still implement the lifecycle, so every
  plugin has the same shape and the same refusal path.

## Consequences

- Config errors surface at startup with a reason, before any external call.
- Tests activate a plugin with a synthetic context and a manifest, which is
  what makes the kernel round-trip test possible.
- Teardown is explicit: the CLI and server can release connections and stop
  background work in a defined order.
- Cost: two methods instead of a module-level side effect, and the caller must
  hold the instance rather than importing a ready object.
