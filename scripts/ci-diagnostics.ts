/**
 * Advisory CI failure classification (issue #183).
 *
 * CI failures have different causes: a deterministic test regression needs a
 * code fix, a native install failure needs a dependency/config fix, and a
 * transient network or runner failure may justify one bounded retry. Treating
 * every failure the same way hides regressions or wastes review time.
 *
 * This is a **suggestion, never a verdict**: the classification is keyword-
 * based over the failing step's name and error text, so it can mislabel an
 * unusual failure. Every result carries `advisory: true`; a retry decision
 * must combine this with the retry policy in `docs/ci-failure-triage.md`,
 * and deterministic test/build failures must never be retried into a pass.
 */
export type FailureCategory =
  | "test-regression"
  | "dependency-resolution"
  | "native-install"
  | "external-provider"
  | "runner-infrastructure"
  | "unknown";

export interface FailureInput {
  /** Workflow job name (or id) that failed. */
  job: string;
  /** Step name (or id) that failed. */
  step: string;
  /** The step's non-zero exit code. */
  exitCode: number;
  /** Sanitized stderr/stdout excerpt; may be omitted. */
  stderr?: string;
  /**
   * The external provider the step talks to, when the failing step is a
   * live-provider call. Distinguishes an external-provider outage from a
   * runner-side network failure for otherwise identical network errors.
   */
  provider?: string;
}

export interface FailureClassification {
  category: FailureCategory;
  /** Always true: this classification is a suggestion, never authoritative. */
  advisory: true;
  /** The matched evidence excerpt, when a rule fired. */
  evidence?: string;
  /** The next debugging action for this category. */
  suggestion: string;
}

/** Ordered, first-match-wins; a more specific cause must fire first. */
const RULES: ReadonlyArray<{ category: FailureCategory; pattern: RegExp }> = [
  {
    // Native build/download failures: the PR #179 class (onnxruntime CUDA
    // archive 404) plus generic node-gyp/prebuild failures.
    category: "native-install",
    pattern: /onnxruntime|node-gyp|gyp ERR|prebuild-install|node-pre-gyp/i,
  },
  {
    // npm registry / lockfile resolution failures.
    category: "dependency-resolution",
    pattern: /ERESOLVE|ETARGET|E404|E403|npm error/i,
  },
  {
    // Deterministic test failure markers; must fire before generic network
    // patterns so a failed assertion inside a test never reads as transient.
    category: "test-regression",
    pattern: /AssertionError|expect\(|Tests failed|test failed/i,
  },
];

/** Network markers that indicate a transient transport failure. */
const NETWORK =
  /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|rate limit|\b429\b|\b503\b/i;

const SUGGESTIONS: Record<FailureCategory, string> = {
  "test-regression":
    "Fix the code or fixture; never retry a deterministic test failure into a pass.",
  "dependency-resolution":
    "Check the lockfile, the pinned version and npm configuration; rerun once after confirming the registry state.",
  "native-install":
    "Check the pinned native package's install configuration and platform support; do not mask with a broad ignore.",
  "external-provider":
    "Record the outage, do not convert it into a passing gate; rerun the scheduled live job later.",
  "runner-infrastructure":
    "One bounded retry is allowed; annotate the retry and keep the first failure visible.",
  unknown: "Read the raw step log before deciding; do not retry an unclassified failure.",
};

export function classifyFailure(input: FailureInput): FailureClassification {
  const text = `${input.step}\n${input.stderr ?? ""}`;
  if (input.exitCode === 0) {
    return { category: "unknown", advisory: true, suggestion: SUGGESTIONS.unknown };
  }
  for (const rule of RULES) {
    const match = text.match(rule.pattern);
    if (match !== null) {
      return {
        category: rule.category,
        advisory: true,
        evidence: match[0],
        suggestion: SUGGESTIONS[rule.category],
      };
    }
  }
  if (NETWORK.test(text)) {
    const category: FailureCategory =
      input.provider === undefined ? "runner-infrastructure" : "external-provider";
    return { category, advisory: true, suggestion: SUGGESTIONS[category] };
  }
  return { category: "unknown", advisory: true, suggestion: SUGGESTIONS.unknown };
}
