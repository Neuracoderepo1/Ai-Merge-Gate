# Policy core: invariants, modes, and limitations

## Invariants

1. **Fail closed.** `PASS` is returned only when *all* of the following hold; anything else is `BLOCK`:
   - the gate config is valid (policy version, mode, a non-empty duplicate-free list of known mandatory checks);
   - acceptance criteria status is `satisfied`;
   - every mandatory check has exactly one well-formed result with status `pass`.
2. **No permissive fallback.** Missing, `null`, wrongly typed, duplicated, ambiguous, or unknown inputs are never defaulted. An unusable config means mandatory checks cannot be determined, so the decision is `BLOCK`.
3. **Pure and deterministic.** Same input, same output (byte-identical JSON). No clock, randomness, network, filesystem, database, or LLM. Enforced by lint rules on `src/` and a source-scanning test.
4. **Never throws.** Hostile input (throwing getters, proxies, non-objects) produces `BLOCK` with `EVALUATOR_INTERNAL_ERROR`.
5. **Own properties only.** Inherited (prototype) properties never satisfy a requirement.
6. **Trust is outside the decision path.** The core has no trust input. Extra properties on the input (e.g. a `trust` score) are ignored and never appear in the output. Tests show that a maximum trust score cannot override a failed mandatory check, and that no trust value changes any decision.
7. **Verdict is independent of mode.** The verdict is computed first; the mode only affects how it is reported.

## Mode semantics

| Mode | PASS verdict | BLOCK verdict | `gatePermitsMerge` |
|---|---|---|---|
| `enforcing` | `checkConclusion: success` | `checkConclusion: failure` | `true` only on PASS |
| `audit_only` | `neutral` | `neutral` | always `false` |
| unknown/invalid | n/a (always BLOCK) | `failure` | always `false` |

- `audit_only` records the would-be verdict in `report.wouldBeVerdict` but is never a success and never represents merge authorization. It is non-blocking for this gate only; other repository protections are unaffected.
- `gatePermitsMerge` is a statement about this gate's result, not a complete merge authorization. The gate must also be a required check, and other protections still apply (not enforced by this package).
- If the mode cannot be read, the decision is reported as `failure`, never `neutral`.

## Failure categories

Every reason has a category, so policy failures can be told apart from failures to evaluate:

| Category | Meaning | Examples |
|---|---|---|
| `policy` | Evaluation completed; the change violates policy | `CHECK_FAILED`, `ACCEPTANCE_UNSATISFIED` |
| `configuration` | A maintainer-supplied input is missing or invalid | `CONFIG_*`, `ACCEPTANCE_MISSING`, `ACCEPTANCE_MALFORMED` |
| `evaluator` | The evaluation could not be completed | `CHECK_ERROR` (scanner error), `CHECK_RESULT_MISSING`, `CHECK_RESULT_INVALID`, `CHECK_RESULT_DUPLICATE`, `RESULTS_INVALID`, `INPUT_INVALID`, `EVALUATOR_INTERNAL_ERROR` |

Reason codes are part of the public contract; a test pins the list. Reasons are sorted by `(code, checkId)`, and messages are static text.

## Input vocabulary

- Check ids (`KNOWN_CHECK_IDS`): `file_scope`, `secret_scan`. Naming any other id as mandatory is `CONFIG_UNKNOWN_CHECK`.
- Check result status: `pass`, `fail` (check ran, violation found), `error` (check could not complete).
- Acceptance status: `satisfied`, `unsatisfied`, `missing`, `malformed` (the last two are produced by an upstream parser).
- Results for ids that are not mandatory are ignored (listed in `ignoredCheckIds`) and cannot stand in for a missing mandatory result.
- A malformed result entry that cannot be tied to a mandatory check still blocks (`CHECK_RESULT_INVALID` without a `checkId`).
- When the config is unusable, results are not evaluated (`checks` is empty).

## Known limitations

- **No provenance.** The core trusts that `checkResults` came from a trusted evaluator. Signing or attesting results is future work.
- **Inputs must come from a trusted source** (e.g. config and criteria read from the base revision). The core cannot tell whether a pull request tampered with them.
- No scanners, GitHub integration, CLI, evidence/hash/audit chain, or trust scoring exist yet.
- The set of check ids is fixed in code; adding checks is a deliberate code change.
- No stale-commit, retry, or duplicate-event handling; those belong to the integration layer and are not modeled here.
- No input size limits: a very large `checkResults` list costs linear time. Callers should bound input.
- Not published; consumed as TypeScript source. Requires Node.js 22+.
