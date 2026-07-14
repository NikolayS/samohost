/**
 * Release-channel policy shared by manifest, registration, trigger, and deploy
 * validation. Keeping this as one literal prevents a hand-edited AppRecord or
 * a programmatic caller from selecting a weaker/ad-hoc workflow.
 */
export const CANONICAL_RELEASE_CI_WORKFLOW = ".github/workflows/ci.yml";

/** GitHub's workflow-runs endpoint identifies the canonical file by basename. */
export const CANONICAL_RELEASE_CI_WORKFLOW_ID = "ci.yml";

export function isCanonicalReleaseCiWorkflow(
  value: string | undefined,
): value is typeof CANONICAL_RELEASE_CI_WORKFLOW {
  return value === CANONICAL_RELEASE_CI_WORKFLOW;
}
