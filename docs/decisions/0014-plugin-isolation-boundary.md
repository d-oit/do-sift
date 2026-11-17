# 0014 — Plugin capability authorization is not runtime isolation

- **Status:** Accepted (2026-11-17)
- **Issue:** #172
- **Supersedes:** none

## Context

The kernel mediates capabilities: a plugin receives host services instead of
raw `fs`/`net`, and `paid`/`computer` capabilities require an explicit recorded
grant. That is an **authorization** boundary. It is not a **runtime** boundary:
in-process JavaScript retains ambient Node.js authority through dynamic
`import()`, `process`, `require` reachable from a dependency, native addons,
prototype access, and shared memory.

Claiming that import policy sandboxes a hostile plugin would be false.

## Decision

1. **Only trusted plugins execute in-process today:** first-party built-ins and
   operator-authored local plugins. Signed/approved external plugins are a
   design target, not a supported deployment.
2. **Untrusted third-party plugin execution is disabled** until a reviewed
   process-level isolation gate passes. No documentation may advertise it as
   safe before then.
3. **The security boundary, when added, is an OS process boundary** with a
   narrow, versioned IPC protocol — not worker threads, which share the
   process and are not a security boundary. Worker threads may be used for
   CPU limits but never as the isolation mechanism.
4. **Capabilities remain authorized at the kernel** regardless of isolation;
   the process boundary is defence in depth and does not replace grants.
5. **Resource limits are mandatory** for any isolated plugin: wall clock,
   memory, CPU, and output size, with kill/restart and crash containment.

## Threat model (summary)

| Attacker capability             | Protected asset                                | Current status                                             |
| ------------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| Hostile plugin code in-process  | Host filesystem, network, environment, secrets | **Not contained.** Trusted plugins only.                   |
| Dependency supply-chain code    | Same                                           | Mitigated by lockfile, review, scheduled advisory scan.    |
| Malicious manifest              | Capability grants, activation                  | Contained by schema validation + explicit grants.          |
| Prompt-injected fetched content | Model instructions, tool calls                 | Treated as data; never executed (AGENTS.md ground rule 2). |
| Resource exhaustion by a plugin | Host availability                              | Not enforced in-process; requires process limits.          |

## Platform notes

- **Linux:** the only platform where a strong boundary is realistic
  (namespaces/seccomp or a container).
- **macOS:** sandbox profiles are possible but not part of the current build.
- **Windows:** no in-repo sandbox primitive; a Job Object + restricted token
  design would have to be implemented and tested separately.
- These differences must be recorded as limits, never papered over.

## Consequences

- `plans/risks.md` R-04 stays **open** with a mitigation of "trusted plugins
  only" until the gate passes.
- A future isolation implementation needs an ADR update, hostile fixtures, and
  a security review before merge.
- Import policy, lint rules, and capability grants are still valuable: they
  prevent accidental authority use and make intent reviewable.
