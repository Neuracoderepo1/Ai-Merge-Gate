# Ai-Merge-Gate

A fail-closed policy core for deciding whether an AI-authored pull request may merge.

This repository currently contains **only the policy core** (milestone `init/core`): a pure, deterministic, database-free TypeScript function, `evaluatePolicy()`, and its tests. There is no scanner, CLI, GitHub Action, audit-chain, or trust-scoring code yet.

## Setup

Requires Node.js 22 or newer.

```sh
npm ci            # install from the lockfile
npm run typecheck # tsc --noEmit (strict)
npm run lint      # eslint, including purity rules for src/
npm test          # vitest
npm run check     # all three
```

## Usage

```ts
import { evaluatePolicy } from "./src/index.ts";

const decision = evaluatePolicy({
  config: { policyVersion: "2026-10-01", mode: "enforcing", mandatoryChecks: ["file_scope", "secret_scan"] },
  acceptanceCriteria: { status: "satisfied" },
  checkResults: [
    { checkId: "file_scope", status: "pass" },
    { checkId: "secret_scan", status: "pass" },
  ],
});
// decision.verdict          -> "PASS" | "BLOCK"
// decision.reasons          -> structured, stably ordered reason codes
// decision.report           -> how to present it (check conclusion, whether the gate permits merge)
```

`evaluatePolicy` accepts `unknown`, validates everything itself, never throws, and never performs I/O.

## Documentation

See [docs/policy.md](docs/policy.md) for the invariants, mode semantics, reason codes, and known limitations.

## Status

Not published, not wired into GitHub. `package.json` is `private` and points at TypeScript source.
