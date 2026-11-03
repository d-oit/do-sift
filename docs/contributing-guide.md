# Getting started as a contributor

A step-by-step walkthrough: build a working search-provider plugin, wire it,
test it, and get it through the gate. Every command here is an approved
command from `AGENTS.md`.

If you only read one other document, read the
[architecture index](architecture/README.md) first.

## 0. Setup

```bash
npm install
npm run check:fast    # format, lint, typecheck, policy, skills, governance, links, docs
npm run check         # the above + tests + evals + build
```

Node 22 or newer. If `npm run check` fails before you changed anything, stop —
record the failure and ask, rather than working around a red baseline.

## 1. Build a mock search provider

A search plugin lives at `packages/plugins/plugin-search-<name>/`. The
smallest useful one returns fixture hits and declares no capabilities, so it
can activate in CI.

```bash
mkdir -p packages/plugins/plugin-search-mock/src
```

**`packages/plugins/plugin-search-mock/plugin.json`**

```json
{
  "name": "search-mock",
  "version": "0.1.0",
  "apiVersion": "1",
  "kind": "search",
  "description": "Offline mock search provider used by the contributor guide and tests.",
  "capabilities": [],
  "permissions": { "networkHosts": [], "secrets": [] },
  "config": {},
  "entry": "createMockSearch"
}
```

**`packages/plugins/plugin-search-mock/package.json`**

```json
{
  "name": "@do-sift/plugin-search-mock",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@do-sift/contracts": "*", "@do-sift/kernel": "*" }
}
```

**`packages/plugins/plugin-search-mock/src/index.ts`**

```ts
import { SearchHit, type SearchHit as SearchHitT } from "@do-sift/contracts";
import type { PluginInstance } from "@do-sift/kernel";

export interface MockSearchInstance extends PluginInstance {
  readonly name: string;
  search(
    query: { text: string; ownerId: string },
    limits: { maxHits: number; timeoutMs: number },
    signal?: AbortSignal,
  ): Promise<SearchHitT[]>;
}

/**
 * A keyless, offline provider. Hits are validated against the contract at the
 * boundary: the plugin object never crosses into storage unvalidated.
 */
export function createMockSearch(): MockSearchInstance {
  let activated = false;
  return {
    name: "mock",
    async activate() {
      activated = true;
    },
    async deactivate() {
      activated = false;
    },
    async search(query, limits, signal) {
      if (!activated) throw new Error("mock search called before activate");
      if (signal?.aborted) throw new Error("aborted");
      const hit = SearchHit.parse({
        url: `https://example.test/${encodeURIComponent(query.text)}`,
        title: `Result for ${query.text}`,
        snippet: "A fixture result from the mock provider.",
        rank: 1,
        provider: "mock",
      });
      return [hit].slice(0, limits.maxHits);
    },
  };
}
```

Then `npm install` again so the workspace link exists, and run
`npm run check:fast`. The policy sensor is the first gate that will object if
something is wrong.

## 2. What the gate is checking

| Sensor       | What it proves about your plugin                                                     |
| ------------ | ------------------------------------------------------------------------------------ |
| `typecheck`  | The manifest's config shape and the exported instance type agree with the contracts. |
| `policy`     | No `node:fs`/`node:net` import in plugin source; no Python; no stealth patterns.     |
| `links`      | Any documentation you added links to real files and headings.                        |
| `tests`      | Your plugin's round-trip test actually ran.                                          |
| `governance` | If you touched a sensitive path, `.github/CODEOWNERS` covers it.                     |

Capabilities are the part people get wrong. Declare the **minimum**:

- `network` — you make outbound requests. You must also list every host in
  `permissions.networkHosts`; the kernel refuses any host not listed.
- `paid` — calls are billable. Cannot activate without an explicit recorded
  grant, and stays disabled in CI.
- `browser`, `computer` — automation. Same grant rule, plus the ethics
  boundary in [guardrails.md](guardrails.md).

## 3. Write the round-trip test

A plugin is not done until a test proves the kernel activates it, grants what
it needs, and refuses what it should not have.

```ts
import { describe, expect, it } from "vitest";
import { Kernel } from "@do-sift/kernel";
import { createMockSearch } from "../src/index.js";

describe("mock search plugin", () => {
  it("activates with zero capabilities and deactivates", async () => {
    const kernel = new Kernel();
    const plugin = createMockSearch();
    await kernel.activate(plugin, { pluginName: "search-mock", config: {} } as never);
    const hits = await plugin.search(
      { text: "everest", ownerId: "owner-a" },
      { maxHits: 3, timeoutMs: 1000 },
    );
    expect(hits).toHaveLength(1);
    await kernel.deactivate("search-mock");
  });
});
```

If your plugin declares `paid` or `computer`, add a second test that proves
activation is refused without a grant. That test is what INV-003 depends on.

## 4. Wiring it into a host

A plugin is inert until a host composes it. In `apps/server/src/main.ts` the
search providers are chosen from configuration; follow the `wikipedia` branch
as the template: create the instance, call `activate` with a context that
carries `network.assertHostAllowed`, and push it into the adapter list. For a
zero-capability mock there is no network assertion to make.

## 5. Document it

- Add the plugin to the table in [architecture/README.md](architecture/README.md)
  if it is a new architectural area rather than an instance of an existing one.
- If it talks to a third party, record the current terms, quotas, and pricing
  with a checked date in `plans/sources.md`. Activation without that entry is
  refused for gated providers, and reviewers will ask.
- If you made a decision a future contributor would question, add a record in
  [decisions/](decisions/README.md).

## 6. Hand off

1. `npm run signals -- verify --set verification` — the receipt-producing
   form of the full gate.
2. Record changed files, commands run, their results, and open risks in the
   relevant `plans/` task row. A task is done when a sensor exits 0, not when
   the code looks right.
3. Open a PR with one task per PR, and answer the checklist in the template.

## Common failures

| Symptom                                         | Cause                                                                                    |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `pluginImports` finding                         | Plugin source imports `node:fs`/`node:net`; use context services.                        |
| Activation refused with an ungranted capability | The manifest declares `paid`/`computer`; that is intended in CI.                         |
| `links` finding                                 | A relative link or `#anchor` does not resolve; the checker names `file:line`.            |
| `governance` finding                            | A sensitive path has no CODEOWNERS rule; see [github-hardening.md](github-hardening.md). |
| Type error on an optional config field          | `exactOptionalPropertyTypes` is on; build the object then assign.                        |
