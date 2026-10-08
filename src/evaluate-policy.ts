import {
  ACCEPTANCE_STATUSES,
  CHECK_STATUSES,
  EXECUTION_MODES,
  KNOWN_CHECK_IDS,
  type CheckOutcome,
  type CheckReport,
  type CheckStatus,
  type ExecutionMode,
  type PolicyDecision,
  type Reason,
  type ReasonCategory,
  type ReasonCode,
  type Report,
  type Verdict,
} from "./types.ts";

const MESSAGES: Record<ReasonCode, string> = {
  ACCEPTANCE_MALFORMED: "Acceptance criteria are malformed.",
  ACCEPTANCE_MISSING: "Acceptance criteria are missing.",
  ACCEPTANCE_UNSATISFIED: "Acceptance criteria are not satisfied.",
  CHECK_ERROR: "A mandatory check could not complete.",
  CHECK_FAILED: "A mandatory check failed.",
  CHECK_RESULT_DUPLICATE: "A mandatory check has more than one result.",
  CHECK_RESULT_INVALID: "A check result is malformed.",
  CHECK_RESULT_MISSING: "A mandatory check has no result.",
  CONFIG_INVALID: "Gate configuration is not an object.",
  CONFIG_MANDATORY_CHECKS_INVALID: "mandatoryChecks must be a non-empty list of unique check ids.",
  CONFIG_MISSING: "Gate configuration is missing.",
  CONFIG_MODE_INVALID: "Execution mode must be audit_only or enforcing.",
  CONFIG_POLICY_VERSION_INVALID: "policyVersion is missing or malformed.",
  CONFIG_UNKNOWN_CHECK: "Configuration names an unknown mandatory check.",
  EVALUATOR_INTERNAL_ERROR: "The policy evaluator failed internally.",
  INPUT_INVALID: "Policy input is not an object.",
  RESULTS_INVALID: "Check results are missing or not a list.",
};

const CATEGORIES: Record<ReasonCode, ReasonCategory> = {
  ACCEPTANCE_MALFORMED: "configuration",
  ACCEPTANCE_MISSING: "configuration",
  ACCEPTANCE_UNSATISFIED: "policy",
  CHECK_ERROR: "evaluator",
  CHECK_FAILED: "policy",
  CHECK_RESULT_DUPLICATE: "evaluator",
  CHECK_RESULT_INVALID: "evaluator",
  CHECK_RESULT_MISSING: "evaluator",
  CONFIG_INVALID: "configuration",
  CONFIG_MANDATORY_CHECKS_INVALID: "configuration",
  CONFIG_MISSING: "configuration",
  CONFIG_MODE_INVALID: "configuration",
  CONFIG_POLICY_VERSION_INVALID: "configuration",
  CONFIG_UNKNOWN_CHECK: "configuration",
  EVALUATOR_INTERNAL_ERROR: "evaluator",
  INPUT_INVALID: "evaluator",
  RESULTS_INVALID: "evaluator",
};

const POLICY_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function reason(code: ReasonCode, checkId?: string): Reason {
  const base = { code, category: CATEGORIES[code], message: MESSAGES[code] };
  return checkId === undefined ? base : { ...base, checkId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads own properties only, so inherited/prototype values can never satisfy a requirement. */
function own(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function isOneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface ConfigResult {
  readonly reasons: Reason[];
  readonly mode: ExecutionMode | null;
  readonly policyVersion: string | null;
  /** Present only when the whole config is valid. */
  readonly mandatory: readonly string[] | null;
}

function readConfig(raw: unknown): ConfigResult {
  if (raw === undefined || raw === null) {
    return { reasons: [reason("CONFIG_MISSING")], mode: null, policyVersion: null, mandatory: null };
  }
  if (!isRecord(raw)) {
    return { reasons: [reason("CONFIG_INVALID")], mode: null, policyVersion: null, mandatory: null };
  }

  const reasons: Reason[] = [];

  const versionRaw = own(raw, "policyVersion");
  const policyVersion =
    typeof versionRaw === "string" && POLICY_VERSION_PATTERN.test(versionRaw) ? versionRaw : null;
  if (policyVersion === null) reasons.push(reason("CONFIG_POLICY_VERSION_INVALID"));

  const modeRaw = own(raw, "mode");
  const mode = isOneOf(EXECUTION_MODES, modeRaw) ? modeRaw : null;
  if (mode === null) reasons.push(reason("CONFIG_MODE_INVALID"));

  const checksRaw = own(raw, "mandatoryChecks");
  let mandatory: string[] | null = null;
  if (!Array.isArray(checksRaw) || checksRaw.length === 0) {
    reasons.push(reason("CONFIG_MANDATORY_CHECKS_INVALID"));
  } else {
    const ids: string[] = [];
    let shapeOk = true;
    for (let i = 0; i < checksRaw.length; i++) {
      const item: unknown = checksRaw[i];
      if (typeof item !== "string" || ids.includes(item)) shapeOk = false;
      else ids.push(item);
    }
    if (!shapeOk) reasons.push(reason("CONFIG_MANDATORY_CHECKS_INVALID"));
    const unknown = ids.filter((id) => !isOneOf(KNOWN_CHECK_IDS, id));
    for (const id of unknown) reasons.push(reason("CONFIG_UNKNOWN_CHECK", id));
    if (shapeOk && unknown.length === 0) mandatory = ids;
  }

  return {
    reasons,
    mode,
    policyVersion,
    mandatory: reasons.length === 0 ? mandatory : null,
  };
}

function readAcceptance(raw: unknown): Reason[] {
  if (raw === undefined || raw === null) return [reason("ACCEPTANCE_MISSING")];
  if (!isRecord(raw)) return [reason("ACCEPTANCE_MALFORMED")];
  const status = own(raw, "status");
  if (!isOneOf(ACCEPTANCE_STATUSES, status)) return [reason("ACCEPTANCE_MALFORMED")];
  switch (status) {
    case "satisfied":
      return [];
    case "unsatisfied":
      return [reason("ACCEPTANCE_UNSATISFIED")];
    case "missing":
      return [reason("ACCEPTANCE_MISSING")];
    case "malformed":
      return [reason("ACCEPTANCE_MALFORMED")];
  }
}

interface Bucket {
  statuses: CheckStatus[];
  malformed: number;
}

interface ChecksResult {
  readonly reasons: Reason[];
  readonly checks: CheckReport[];
  readonly ignored: string[];
}

function readChecks(raw: unknown, mandatory: readonly string[]): ChecksResult {
  const ids = [...mandatory].sort(compare);
  const buckets = new Map<string, Bucket>(ids.map((id) => [id, { statuses: [], malformed: 0 }]));
  const ignored = new Set<string>();
  const reasons: Reason[] = [];

  if (!Array.isArray(raw)) {
    reasons.push(reason("RESULTS_INVALID"));
    return { reasons, checks: ids.map((checkId) => ({ checkId, outcome: "missing" })), ignored: [] };
  }

  let unattributable = false;
  for (let i = 0; i < raw.length; i++) {
    const entry: unknown = raw[i];
    const idRaw = isRecord(entry) ? own(entry, "checkId") : undefined;
    const statusRaw = isRecord(entry) ? own(entry, "status") : undefined;
    const bucket = typeof idRaw === "string" ? buckets.get(idRaw) : undefined;
    const wellFormed = typeof idRaw === "string" && isOneOf(CHECK_STATUSES, statusRaw);

    if (wellFormed) {
      if (bucket) bucket.statuses.push(statusRaw);
      else ignored.add(idRaw);
    } else if (bucket) {
      bucket.malformed += 1;
    } else {
      unattributable = true;
    }
  }
  if (unattributable) reasons.push(reason("CHECK_RESULT_INVALID"));

  const checks: CheckReport[] = [];
  for (const checkId of ids) {
    const bucket = buckets.get(checkId);
    const statuses = bucket?.statuses ?? [];
    const malformed = bucket?.malformed ?? 0;
    const total = statuses.length + malformed;

    let outcome: CheckOutcome;
    if (total === 0) outcome = "missing";
    else if (total > 1) outcome = "duplicate";
    else if (malformed === 1) outcome = "invalid";
    else outcome = statuses[0] ?? "missing";
    checks.push({ checkId, outcome });

    switch (outcome) {
      case "pass":
        break;
      case "fail":
        reasons.push(reason("CHECK_FAILED", checkId));
        break;
      case "error":
        reasons.push(reason("CHECK_ERROR", checkId));
        break;
      case "missing":
        reasons.push(reason("CHECK_RESULT_MISSING", checkId));
        break;
      case "invalid":
        reasons.push(reason("CHECK_RESULT_INVALID", checkId));
        break;
      case "duplicate":
        reasons.push(reason("CHECK_RESULT_DUPLICATE", checkId));
        break;
    }
  }

  return { reasons, checks, ignored: [...ignored].sort(compare) };
}

function buildReport(mode: ExecutionMode | null, verdict: Verdict): Report {
  if (mode === "audit_only") {
    // Never a success, never an authorization: the verdict is recorded, not enforced.
    return { mode, checkConclusion: "neutral", gatePermitsMerge: false, wouldBeVerdict: verdict };
  }
  if (mode === "enforcing") {
    const pass = verdict === "PASS";
    return {
      mode,
      checkConclusion: pass ? "success" : "failure",
      gatePermitsMerge: pass,
      wouldBeVerdict: verdict,
    };
  }
  // Mode unknown: never permissive.
  return { mode: null, checkConclusion: "failure", gatePermitsMerge: false, wouldBeVerdict: verdict };
}

function finalize(
  reasons: readonly Reason[],
  mode: ExecutionMode | null,
  policyVersion: string | null,
  checks: readonly CheckReport[],
  ignored: readonly string[],
): PolicyDecision {
  const sorted = [...reasons].sort(
    (a, b) => compare(a.code, b.code) || compare(a.checkId ?? "", b.checkId ?? ""),
  );
  const verdict: Verdict = sorted.length === 0 ? "PASS" : "BLOCK";
  const categories = [...new Set(sorted.map((r) => r.category))].sort(compare);
  return {
    schemaVersion: 1,
    verdict,
    policyVersion,
    reasons: sorted,
    categories,
    checks,
    ignoredCheckIds: ignored,
    report: buildReport(mode, verdict),
  };
}

/**
 * Pure, deterministic policy evaluation. Never throws; never performs I/O.
 *
 * PASS requires: a valid config, satisfied acceptance criteria, and exactly one
 * well-formed `pass` result for every mandatory check. Anything else is BLOCK.
 * Trust scores (or any other unknown input property) are never read.
 */
export function evaluatePolicy(input: unknown): PolicyDecision {
  try {
    if (!isRecord(input)) return finalize([reason("INPUT_INVALID")], null, null, [], []);

    const config = readConfig(own(input, "config"));
    const reasons: Reason[] = [...config.reasons, ...readAcceptance(own(input, "acceptanceCriteria"))];

    let checks: CheckReport[] = [];
    let ignored: string[] = [];
    if (config.mandatory !== null) {
      const result = readChecks(own(input, "checkResults"), config.mandatory);
      reasons.push(...result.reasons);
      checks = result.checks;
      ignored = result.ignored;
    }

    return finalize(reasons, config.mode, config.policyVersion, checks, ignored);
  } catch {
    // Hostile or broken input (e.g. a throwing getter): fail closed, leak nothing.
    return finalize([reason("EVALUATOR_INTERNAL_ERROR")], null, null, [], []);
  }
}
