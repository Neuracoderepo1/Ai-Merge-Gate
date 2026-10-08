/**
 * Public types for the AI Merge Gate policy core.
 *
 * The core is pure: it never performs I/O, never reads the clock, and never
 * consults a trust score. `evaluatePolicy` accepts `unknown` at runtime and
 * validates everything itself; the `PolicyInput` shape below documents the
 * well-formed input.
 */

export const EXECUTION_MODES = ["audit_only", "enforcing"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** Mandatory-check identifiers the core recognises. Anything else is rejected. */
export const KNOWN_CHECK_IDS = ["file_scope", "secret_scan"] as const;
export type KnownCheckId = (typeof KNOWN_CHECK_IDS)[number];

export const CHECK_STATUSES = ["pass", "fail", "error"] as const;
/** `fail` = the check ran and found a policy violation. `error` = the check could not complete. */
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const ACCEPTANCE_STATUSES = ["satisfied", "unsatisfied", "missing", "malformed"] as const;
export type AcceptanceStatus = (typeof ACCEPTANCE_STATUSES)[number];

export interface GateConfig {
  /** Identifier of the policy version being enforced (recorded in the decision). */
  readonly policyVersion: string;
  readonly mode: ExecutionMode;
  /** Non-empty, duplicate-free list of known check ids that must all pass. */
  readonly mandatoryChecks: readonly KnownCheckId[];
}

export interface AcceptanceCriteriaInput {
  readonly status: AcceptanceStatus;
}

export interface CheckResult {
  readonly checkId: string;
  readonly status: CheckStatus;
}

export interface PolicyInput {
  readonly config: GateConfig;
  readonly acceptanceCriteria: AcceptanceCriteriaInput;
  readonly checkResults: readonly CheckResult[];
}

export type Verdict = "PASS" | "BLOCK";

/**
 * - `policy`: the evaluation completed and the change violates policy.
 * - `configuration`: a maintainer-supplied input (gate config, acceptance criteria) is missing or invalid.
 * - `evaluator`: the evaluation could not be completed (check error, missing/invalid result, internal error).
 */
export type ReasonCategory = "policy" | "configuration" | "evaluator";

export const REASON_CODES = [
  "ACCEPTANCE_MALFORMED",
  "ACCEPTANCE_MISSING",
  "ACCEPTANCE_UNSATISFIED",
  "CHECK_ERROR",
  "CHECK_FAILED",
  "CHECK_RESULT_DUPLICATE",
  "CHECK_RESULT_INVALID",
  "CHECK_RESULT_MISSING",
  "CONFIG_INVALID",
  "CONFIG_MANDATORY_CHECKS_INVALID",
  "CONFIG_MISSING",
  "CONFIG_MODE_INVALID",
  "CONFIG_POLICY_VERSION_INVALID",
  "CONFIG_UNKNOWN_CHECK",
  "EVALUATOR_INTERNAL_ERROR",
  "INPUT_INVALID",
  "RESULTS_INVALID",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface Reason {
  readonly code: ReasonCode;
  readonly category: ReasonCategory;
  /** Present only for reasons attributable to a single check. */
  readonly checkId?: string;
  /** Static text per code; never derived from input. */
  readonly message: string;
}

export type CheckOutcome = "pass" | "fail" | "error" | "missing" | "invalid" | "duplicate";

export interface CheckReport {
  readonly checkId: string;
  readonly outcome: CheckOutcome;
}

/** How a GitHub Check should present the verdict. Derived from verdict + mode only. */
export type CheckConclusion = "success" | "failure" | "neutral";

export interface Report {
  /** `null` when the mode could not be established (treated as enforcing-like: never permissive). */
  readonly mode: ExecutionMode | null;
  readonly checkConclusion: CheckConclusion;
  /**
   * True only when mode is `enforcing` and the verdict is `PASS`.
   * Never true in `audit_only`. Other repository protections still apply.
   */
  readonly gatePermitsMerge: boolean;
  /** Always equal to `PolicyDecision.verdict`; kept explicit so audit_only output is self-describing. */
  readonly wouldBeVerdict: Verdict;
}

export interface PolicyDecision {
  readonly schemaVersion: 1;
  /** The underlying policy verdict. Independent of mode. */
  readonly verdict: Verdict;
  readonly policyVersion: string | null;
  /** Sorted by (code, checkId). Empty iff verdict is PASS. */
  readonly reasons: readonly Reason[];
  /** Sorted, de-duplicated categories present in `reasons`. */
  readonly categories: readonly ReasonCategory[];
  /** Per mandatory check, sorted by checkId. Empty when the config is unusable. */
  readonly checks: readonly CheckReport[];
  /** Well-formed results for check ids that are not mandatory; they never affect the verdict. */
  readonly ignoredCheckIds: readonly string[];
  readonly report: Report;
}
