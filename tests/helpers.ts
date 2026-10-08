import type { PolicyInput } from "../src/index.ts";

export function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: PolicyInput = {
    config: { policyVersion: "2026-10-01", mode: "enforcing", mandatoryChecks: ["file_scope", "secret_scan"] },
    acceptanceCriteria: { status: "satisfied" },
    checkResults: [
      { checkId: "file_scope", status: "pass" },
      { checkId: "secret_scan", status: "pass" },
    ],
  };
  return { ...base, ...overrides };
}

export function withConfig(config: Record<string, unknown>): Record<string, unknown> {
  const base = validInput()["config"] as Record<string, unknown>;
  return validInput({ config: { ...base, ...config } });
}

export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
