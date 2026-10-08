import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluatePolicy, REASON_CODES, type PolicyDecision } from "../src/index.ts";
import { deepFreeze, validInput, withConfig } from "./helpers.ts";

const codes = (d: PolicyDecision) => d.reasons.map((r) => r.code);

describe("all-pass", () => {
  it("enforcing: PASS, success, permits merge", () => {
    const d = evaluatePolicy(validInput());
    expect(d.verdict).toBe("PASS");
    expect(d.reasons).toEqual([]);
    expect(d.categories).toEqual([]);
    expect(d.checks).toEqual([
      { checkId: "file_scope", outcome: "pass" },
      { checkId: "secret_scan", outcome: "pass" },
    ]);
    expect(d.report).toEqual({ mode: "enforcing", checkConclusion: "success", gatePermitsMerge: true, wouldBeVerdict: "PASS" });
    expect(d.policyVersion).toBe("2026-10-01");
  });

  it("audit_only: records would-be PASS but is neutral and never authorizes", () => {
    const d = evaluatePolicy(withConfig({ mode: "audit_only" }));
    expect(d.verdict).toBe("PASS");
    expect(d.report).toEqual({ mode: "audit_only", checkConclusion: "neutral", gatePermitsMerge: false, wouldBeVerdict: "PASS" });
  });
});

describe("single failure (table)", () => {
  const cases: [string, Record<string, unknown>, string, string][] = [
    ["file_scope fails", validInput({ checkResults: [{ checkId: "file_scope", status: "fail" }, { checkId: "secret_scan", status: "pass" }] }), "CHECK_FAILED", "file_scope"],
    ["secret_scan fails", validInput({ checkResults: [{ checkId: "file_scope", status: "pass" }, { checkId: "secret_scan", status: "fail" }] }), "CHECK_FAILED", "secret_scan"],
  ];
  it.each(cases)("%s", (_name, input, code, checkId) => {
    const d = evaluatePolicy(input);
    expect(d.verdict).toBe("BLOCK");
    expect(d.reasons).toEqual([expect.objectContaining({ code, category: "policy", checkId })]);
    expect(d.categories).toEqual(["policy"]);
    expect(d.report.gatePermitsMerge).toBe(false);
    expect(d.report.checkConclusion).toBe("failure");
  });

  it("unsatisfied acceptance criteria alone blocks (policy)", () => {
    const d = evaluatePolicy(validInput({ acceptanceCriteria: { status: "unsatisfied" } }));
    expect(d.verdict).toBe("BLOCK");
    expect(codes(d)).toEqual(["ACCEPTANCE_UNSATISFIED"]);
    expect(d.categories).toEqual(["policy"]);
  });
});

describe("multiple failures", () => {
  it("reports every reason in stable (code, checkId) order", () => {
    const d = evaluatePolicy(
      validInput({
        acceptanceCriteria: { status: "unsatisfied" },
        checkResults: [{ checkId: "secret_scan", status: "fail" }, { checkId: "file_scope", status: "error" }],
      }),
    );
    expect(d.verdict).toBe("BLOCK");
    expect(d.reasons.map((r) => [r.code, r.checkId])).toEqual([
      ["ACCEPTANCE_UNSATISFIED", undefined],
      ["CHECK_ERROR", "file_scope"],
      ["CHECK_FAILED", "secret_scan"],
    ]);
    expect(d.categories).toEqual(["evaluator", "policy"]);
  });
});

describe("missing configuration (fail closed)", () => {
  it.each([[undefined], [null]])("config=%s", (config) => {
    const d = evaluatePolicy(validInput({ config }));
    expect(d.verdict).toBe("BLOCK");
    expect(codes(d)).toContain("CONFIG_MISSING");
    expect(d.categories).toContain("configuration");
    expect(d.report).toMatchObject({ mode: null, checkConclusion: "failure", gatePermitsMerge: false });
    expect(d.checks).toEqual([]);
  });
});

describe("malformed configuration (table)", () => {
  const cases: [string, unknown, string][] = [
    ["config is a string", "enforcing", "CONFIG_INVALID"],
    ["config is a number", 1, "CONFIG_INVALID"],
    ["config is an array", [], "CONFIG_INVALID"],
    ["policyVersion absent", { mode: "enforcing", mandatoryChecks: ["file_scope"] }, "CONFIG_POLICY_VERSION_INVALID"],
    ["policyVersion empty", { policyVersion: "", mode: "enforcing", mandatoryChecks: ["file_scope"] }, "CONFIG_POLICY_VERSION_INVALID"],
    ["policyVersion has spaces/symbols", { policyVersion: "v 1;", mode: "enforcing", mandatoryChecks: ["file_scope"] }, "CONFIG_POLICY_VERSION_INVALID"],
    ["policyVersion not a string", { policyVersion: 1, mode: "enforcing", mandatoryChecks: ["file_scope"] }, "CONFIG_POLICY_VERSION_INVALID"],
    ["mode absent", { policyVersion: "1", mandatoryChecks: ["file_scope"] }, "CONFIG_MODE_INVALID"],
    ["mode unknown", { policyVersion: "1", mode: "permissive", mandatoryChecks: ["file_scope"] }, "CONFIG_MODE_INVALID"],
    ["mode wrong case", { policyVersion: "1", mode: "Enforcing", mandatoryChecks: ["file_scope"] }, "CONFIG_MODE_INVALID"],
    ["mandatoryChecks absent", { policyVersion: "1", mode: "enforcing" }, "CONFIG_MANDATORY_CHECKS_INVALID"],
    ["mandatoryChecks empty", { policyVersion: "1", mode: "enforcing", mandatoryChecks: [] }, "CONFIG_MANDATORY_CHECKS_INVALID"],
    ["mandatoryChecks not an array", { policyVersion: "1", mode: "enforcing", mandatoryChecks: "file_scope" }, "CONFIG_MANDATORY_CHECKS_INVALID"],
    ["mandatoryChecks has non-string", { policyVersion: "1", mode: "enforcing", mandatoryChecks: ["file_scope", 7] }, "CONFIG_MANDATORY_CHECKS_INVALID"],
    ["mandatoryChecks has duplicates", { policyVersion: "1", mode: "enforcing", mandatoryChecks: ["file_scope", "file_scope"] }, "CONFIG_MANDATORY_CHECKS_INVALID"],
  ];
  it.each(cases)("%s -> BLOCK with %s", (_name, config, code) => {
    const d = evaluatePolicy(validInput({ config }));
    expect(d.verdict).toBe("BLOCK");
    expect(codes(d)).toContain(code);
    expect(d.categories).toContain("configuration");
    expect(d.report.gatePermitsMerge).toBe(false);
    expect(d.checks).toEqual([]); // results are not evaluated against an unusable config
  });

  it("inherited (prototype) properties never satisfy config requirements", () => {
    const config = Object.create({ policyVersion: "1", mode: "enforcing", mandatoryChecks: ["file_scope"] }) as unknown;
    const d = evaluatePolicy(validInput({ config }));
    expect(d.verdict).toBe("BLOCK");
    expect(codes(d)).toEqual(
      expect.arrayContaining(["CONFIG_POLICY_VERSION_INVALID", "CONFIG_MODE_INVALID", "CONFIG_MANDATORY_CHECKS_INVALID"]),
    );
  });
});

describe("unknown mandatory check", () => {
  it("is a configuration failure, not silently ignored", () => {
    const d = evaluatePolicy(withConfig({ mandatoryChecks: ["file_scope", "secret_scan", "made_up_check"] }));
    expect(d.verdict).toBe("BLOCK");
    expect(d.reasons).toEqual([expect.objectContaining({ code: "CONFIG_UNKNOWN_CHECK", checkId: "made_up_check", category: "configuration" })]);
  });
});

describe("acceptance criteria (table)", () => {
  const cases: [string, unknown, string, string][] = [
    ["absent", undefined, "ACCEPTANCE_MISSING", "configuration"],
    ["null", null, "ACCEPTANCE_MISSING", "configuration"],
    ["status missing", { status: "missing" }, "ACCEPTANCE_MISSING", "configuration"],
    ["status malformed", { status: "malformed" }, "ACCEPTANCE_MALFORMED", "configuration"],
    ["not an object", "satisfied", "ACCEPTANCE_MALFORMED", "configuration"],
    ["object without status", {}, "ACCEPTANCE_MALFORMED", "configuration"],
    ["unknown status", { status: "approved" }, "ACCEPTANCE_MALFORMED", "configuration"],
    ["status wrong type", { status: true }, "ACCEPTANCE_MALFORMED", "configuration"],
    ["unsatisfied", { status: "unsatisfied" }, "ACCEPTANCE_UNSATISFIED", "policy"],
  ];
  it.each(cases)("%s -> %s", (_name, acceptanceCriteria, code, category) => {
    const d = evaluatePolicy(validInput({ acceptanceCriteria }));
    expect(d.verdict).toBe("BLOCK");
    expect(d.reasons).toEqual([expect.objectContaining({ code, category })]);
  });

  it("an audit_only mode keeps the BLOCK verdict but stays non-blocking (neutral)", () => {
    const d = evaluatePolicy(withConfig({ mode: "audit_only" }));
    const missing = evaluatePolicy({ ...withConfig({ mode: "audit_only" }), acceptanceCriteria: undefined });
    expect(d.verdict).toBe("PASS");
    expect(missing.verdict).toBe("BLOCK");
    expect(missing.report).toEqual({ mode: "audit_only", checkConclusion: "neutral", gatePermitsMerge: false, wouldBeVerdict: "BLOCK" });
  });
});

describe("check results: missing and invalid (table)", () => {
  const pass = (checkId: string) => ({ checkId, status: "pass" });
  const cases: [string, unknown, string[], Record<string, string>][] = [
    ["one result missing", [pass("file_scope")], ["CHECK_RESULT_MISSING"], { secret_scan: "missing" }],
    ["all results missing (empty list)", [], ["CHECK_RESULT_MISSING", "CHECK_RESULT_MISSING"], { file_scope: "missing", secret_scan: "missing" }],
    ["results undefined", undefined, ["RESULTS_INVALID"], { file_scope: "missing", secret_scan: "missing" }],
    ["results not a list", { file_scope: "pass" }, ["RESULTS_INVALID"], { file_scope: "missing", secret_scan: "missing" }],
    ["unknown status value", [pass("file_scope"), { checkId: "secret_scan", status: "ok" }], ["CHECK_RESULT_INVALID"], { secret_scan: "invalid" }],
    ["status wrong type", [pass("file_scope"), { checkId: "secret_scan", status: true }], ["CHECK_RESULT_INVALID"], { secret_scan: "invalid" }],
    ["status absent", [pass("file_scope"), { checkId: "secret_scan" }], ["CHECK_RESULT_INVALID"], { secret_scan: "invalid" }],
    ["entry is not an object", [pass("file_scope"), pass("secret_scan"), "pass"], ["CHECK_RESULT_INVALID"], { file_scope: "pass", secret_scan: "pass" }],
    ["entry has no checkId", [pass("file_scope"), pass("secret_scan"), { status: "pass" }], ["CHECK_RESULT_INVALID"], { file_scope: "pass", secret_scan: "pass" }],
    ["entry is null", [pass("file_scope"), pass("secret_scan"), null], ["CHECK_RESULT_INVALID"], { file_scope: "pass", secret_scan: "pass" }],
    ["duplicate agreeing results", [pass("file_scope"), pass("file_scope"), pass("secret_scan")], ["CHECK_RESULT_DUPLICATE"], { file_scope: "duplicate" }],
    ["duplicate conflicting results", [pass("file_scope"), { checkId: "file_scope", status: "fail" }, pass("secret_scan")], ["CHECK_RESULT_DUPLICATE"], { file_scope: "duplicate" }],
    ["valid + malformed for the same check", [pass("file_scope"), { checkId: "file_scope" }, pass("secret_scan")], ["CHECK_RESULT_DUPLICATE"], { file_scope: "duplicate" }],
  ];
  it.each(cases)("%s -> BLOCK", (_name, checkResults, expectedCodes, outcomes) => {
    const d = evaluatePolicy(validInput({ checkResults }));
    expect(d.verdict).toBe("BLOCK");
    expect(codes(d)).toEqual(expectedCodes);
    expect(d.categories).toEqual(["evaluator"]);
    for (const [checkId, outcome] of Object.entries(outcomes)) {
      expect(d.checks.find((c) => c.checkId === checkId)?.outcome).toBe(outcome);
    }
  });

  it("inherited properties on a result entry do not make it valid", () => {
    const entry = Object.create({ checkId: "secret_scan", status: "pass" }) as unknown;
    const d = evaluatePolicy(validInput({ checkResults: [{ checkId: "file_scope", status: "pass" }, entry] }));
    expect(d.verdict).toBe("BLOCK");
    expect(codes(d)).toEqual(expect.arrayContaining(["CHECK_RESULT_INVALID", "CHECK_RESULT_MISSING"]));
  });

  it("results for non-mandatory checks are ignored and cannot stand in for a missing mandatory result", () => {
    const only = withConfig({ mandatoryChecks: ["file_scope"] });
    const ok = evaluatePolicy({ ...only, checkResults: [{ checkId: "file_scope", status: "pass" }, { checkId: "secret_scan", status: "fail" }] });
    expect(ok.verdict).toBe("PASS");
    expect(ok.ignoredCheckIds).toEqual(["secret_scan"]);
    const missing = evaluatePolicy({ ...only, checkResults: [{ checkId: "secret_scan", status: "pass" }] });
    expect(missing.verdict).toBe("BLOCK");
    expect(codes(missing)).toEqual(["CHECK_RESULT_MISSING"]);
  });
});

describe("scanner / evaluator error vs policy failure", () => {
  it("error is an evaluator failure; fail is a policy failure; both BLOCK", () => {
    const err = evaluatePolicy(validInput({ checkResults: [{ checkId: "file_scope", status: "pass" }, { checkId: "secret_scan", status: "error" }] }));
    const fail = evaluatePolicy(validInput({ checkResults: [{ checkId: "file_scope", status: "pass" }, { checkId: "secret_scan", status: "fail" }] }));
    expect(err.verdict).toBe("BLOCK");
    expect(fail.verdict).toBe("BLOCK");
    expect(err.reasons[0]).toMatchObject({ code: "CHECK_ERROR", category: "evaluator", checkId: "secret_scan" });
    expect(fail.reasons[0]).toMatchObject({ code: "CHECK_FAILED", category: "policy", checkId: "secret_scan" });
    expect(err.categories).toEqual(["evaluator"]);
    expect(fail.categories).toEqual(["policy"]);
  });

  it("a thrown/hostile input is an evaluator failure, never a PASS, and never throws", () => {
    const throwing = { get config(): unknown { throw new Error("boom"); } };
    const proxy = new Proxy({}, { get() { throw new Error("boom"); }, has() { throw new Error("boom"); }, getOwnPropertyDescriptor() { throw new Error("boom"); } });
    for (const input of [throwing, proxy]) {
      const d = evaluatePolicy(input);
      expect(d.verdict).toBe("BLOCK");
      expect(codes(d)).toEqual(["EVALUATOR_INTERNAL_ERROR"]);
      expect(d.report).toMatchObject({ mode: null, checkConclusion: "failure", gatePermitsMerge: false });
    }
  });

  it.each([[undefined], [null], [42], ["pass"], [[]], [true]])("non-object input %s -> INPUT_INVALID", (input) => {
    const d = evaluatePolicy(input);
    expect(d.verdict).toBe("BLOCK");
    expect(codes(d)).toEqual(["INPUT_INVALID"]);
    expect(d.report.gatePermitsMerge).toBe(false);
  });
});

describe("execution modes", () => {
  const modeCases = [
    { mode: "enforcing", verdict: "PASS", conclusion: "success", permits: true },
    { mode: "enforcing", verdict: "BLOCK", conclusion: "failure", permits: false },
    { mode: "audit_only", verdict: "PASS", conclusion: "neutral", permits: false },
    { mode: "audit_only", verdict: "BLOCK", conclusion: "neutral", permits: false },
  ] as const;

  it.each(modeCases)("$mode + $verdict -> $conclusion, permits=$permits", ({ mode, verdict, conclusion, permits }) => {
    const results = verdict === "PASS" ? "pass" : "fail";
    const d = evaluatePolicy({
      ...withConfig({ mode }),
      checkResults: [{ checkId: "file_scope", status: results }, { checkId: "secret_scan", status: "pass" }],
    });
    expect(d.verdict).toBe(verdict);
    expect(d.report).toEqual({ mode, checkConclusion: conclusion, gatePermitsMerge: permits, wouldBeVerdict: verdict });
  });

  it("the verdict does not depend on the mode (verdict and reporting are separate)", () => {
    const failing = { checkResults: [{ checkId: "file_scope", status: "fail" }, { checkId: "secret_scan", status: "error" }] };
    const a = evaluatePolicy({ ...withConfig({ mode: "enforcing" }), ...failing });
    const b = evaluatePolicy({ ...withConfig({ mode: "audit_only" }), ...failing });
    expect({ ...a, report: undefined }).toEqual({ ...b, report: undefined });
  });

  it("an invalid mode can never PASS or authorize", () => {
    const d = evaluatePolicy(withConfig({ mode: "shadow" }));
    expect(d.verdict).toBe("BLOCK");
    expect(d.report).toEqual({ mode: null, checkConclusion: "failure", gatePermitsMerge: false, wouldBeVerdict: "BLOCK" });
  });
});

describe("trust cannot influence the verdict", () => {
  const trustValues: unknown[] = [100, 1, 0, -1, Number.MAX_VALUE, Infinity, NaN, "100", "max", true, { score: 100 }, [100], { score: 1, factors: ["perfect history"] }];
  const failing = validInput({ checkResults: [{ checkId: "file_scope", status: "fail" }, { checkId: "secret_scan", status: "pass" }] });

  it.each(trustValues.map((t) => [t]))("maximum/odd trust %j cannot override a failed mandatory check", (trust) => {
    const baseline = evaluatePolicy(failing);
    expect(baseline.verdict).toBe("BLOCK");
    const placements = [
      { ...failing, trust },
      { ...failing, trustScore: trust },
      { ...failing, config: { ...(failing["config"] as object), trust, trustThreshold: 0 } },
      { ...failing, acceptanceCriteria: { status: "satisfied", trust } },
      { ...failing, checkResults: [{ checkId: "file_scope", status: "fail", trust }, { checkId: "secret_scan", status: "pass" }] },
    ];
    for (const input of placements) {
      const d = evaluatePolicy(input);
      expect(d.verdict).toBe("BLOCK");
      expect(d).toEqual(baseline);
    }
  });

  it("trust also cannot turn a PASS into a different outcome, and never appears in output", () => {
    const baseline = evaluatePolicy(validInput());
    for (const trust of trustValues) {
      const d = evaluatePolicy({ ...validInput(), trust });
      expect(d).toEqual(baseline);
      expect(JSON.stringify(d)).not.toMatch(/trust/i);
    }
  });

  it("a trust-only input with no passing checks never PASSes", () => {
    const d = evaluatePolicy({ config: validInput()["config"], acceptanceCriteria: { status: "satisfied" }, checkResults: [], trust: { score: 100 } });
    expect(d.verdict).toBe("BLOCK");
    expect(codes(d)).toEqual(["CHECK_RESULT_MISSING", "CHECK_RESULT_MISSING"]);
  });
});

describe("determinism and purity", () => {
  it("identical inputs produce byte-identical output", () => {
    const input = validInput({ checkResults: [{ checkId: "secret_scan", status: "fail" }, { checkId: "file_scope", status: "error" }] });
    const runs = Array.from({ length: 5 }, () => JSON.stringify(evaluatePolicy(structuredClone(input))));
    expect(new Set(runs).size).toBe(1);
  });

  it("result order and mandatoryChecks order do not change the output", () => {
    const a = evaluatePolicy({ ...withConfig({ mandatoryChecks: ["file_scope", "secret_scan"] }), checkResults: [{ checkId: "file_scope", status: "fail" }, { checkId: "secret_scan", status: "error" }] });
    const b = evaluatePolicy({ ...withConfig({ mandatoryChecks: ["secret_scan", "file_scope"] }), checkResults: [{ checkId: "secret_scan", status: "error" }, { checkId: "file_scope", status: "fail" }] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("does not mutate (deep-frozen) input", () => {
    const input = deepFreeze(validInput());
    expect(() => evaluatePolicy(input)).not.toThrow();
  });

  it("source files contain no I/O, network, clock, or randomness", () => {
    const forbidden = [/\bfetch\s*\(/, /\bprocess\b/, /\bDate\b/, /Math\.random/, /from\s+["']node:/, /from\s+["'](fs|http|https|net|child_process)["']/, /supabase/i, /\bimport\s*\(/, /\beval\s*\(/];
    for (const file of readdirSync(new URL("../src/", import.meta.url))) {
      const text = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
      for (const pattern of forbidden) expect(text, `${file} matches ${String(pattern)}`).not.toMatch(pattern);
    }
  });
});

describe("invariants over the full input grid", () => {
  const acceptance = ["satisfied", "unsatisfied", "missing", "malformed", undefined] as const;
  const status = ["pass", "fail", "error", "bogus", undefined] as const; // undefined = no result at all
  const modes = ["enforcing", "audit_only"] as const;

  const entries = (checkId: string, s: (typeof status)[number]) => (s === undefined ? [] : [{ checkId, status: s }]);

  it("PASS iff acceptance satisfied and every mandatory check passed; permits only when enforcing", () => {
    let combos = 0;
    for (const mode of modes) {
      for (const a of acceptance) {
        for (const f of status) {
          for (const s of status) {
            combos += 1;
            const d = evaluatePolicy({
              ...withConfig({ mode }),
              acceptanceCriteria: a === undefined ? undefined : { status: a },
              checkResults: [...entries("file_scope", f), ...entries("secret_scan", s)],
            });
            const shouldPass = a === "satisfied" && f === "pass" && s === "pass";
            const label = JSON.stringify({ mode, a, f, s });
            expect(d.verdict, label).toBe(shouldPass ? "PASS" : "BLOCK");
            expect(d.reasons.length === 0, label).toBe(shouldPass);
            expect(d.report.gatePermitsMerge, label).toBe(shouldPass && mode === "enforcing");
            expect(d.report.wouldBeVerdict, label).toBe(d.verdict);
            if (mode === "audit_only") expect(d.report.checkConclusion, label).toBe("neutral");
            for (const r of d.reasons) expect(REASON_CODES, label).toContain(r.code);
          }
        }
      }
    }
    expect(combos).toBe(2 * 5 * 5 * 5);
  });
});

describe("stable reason codes", () => {
  it("the public reason-code list is unchanged (renames are breaking changes)", () => {
    expect([...REASON_CODES]).toEqual([
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
    ]);
  });
});
