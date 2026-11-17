# Plugin isolation: threat model and gate (#172)

This document is the readable companion to
[ADR 0014](decisions/0014-plugin-isolation-boundary.md). It records what the
current kernel does and does **not** protect, so no deployment claims a sandbox
it does not have.

## Trust levels

| Level                    | Example                                    | Current support        |
| ------------------------ | ------------------------------------------ | ---------------------- |
| First-party built-in     | `packages/plugins/plugin-search-wikipedia` | In-process, trusted    |
| Operator-authored local  | A plugin committed by the operator         | In-process, trusted    |
| Signed/approved external | Distributed plugin with a signature        | **Design target only** |
| Untrusted third-party    | Arbitrary downloaded code                  | **Not supported**      |

## Ambient authority an in-process plugin can reach

- `node:fs`, `node:net`, `node:child_process` via dynamic `import()` or a
  transitive dependency (static imports are linted, dynamic ones are not a
  boundary).
- `process.env`, including credentials the host exports.
- Native addons and shared memory.
- Prototype mutation (e.g. replacing `Array.prototype` methods used by the
  host).
- Unlimited CPU/memory unless the host process limits it.

The kernel's capability grants and import checks reduce **accidental** use and
make **intent** reviewable. They cannot stop hostile code.

## Gate before any untrusted execution

1. Process boundary with a narrow versioned IPC protocol (request/response,
   no host object handles).
2. Deny filesystem, network, and secret access unless explicitly brokered.
3. Wall-clock, memory, CPU, and output-size limits with kill/restart.
4. Hostile fixtures that attempt each escape path in the table above.
5. Platform limitations documented (Linux strongest; macOS/Windows gaps named).
6. An ADR update and a security review before merge.

Until 1–6 pass, the product must say **trusted plugins only**.

## R-04 status

Open. Mitigation: only first-party and operator-authored plugins execute;
external distribution is blocked. This is an honest residual risk, not a
claim of isolation.
