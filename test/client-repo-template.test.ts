/**
 * test/client-repo-template.test.ts — deploy-model clarity gate.
 *
 * Root cause: a human ad-hoc granted a per-bot SSH key on a client app VM
 * because the client-repo CLAUDE.md template and docs/stack/deploy.md were
 * ambiguous about WHO deploys prod and whether the app author ever SSHes into
 * the VM. samohost prod is control-plane push-based; no per-agent key should
 * ever be installed on a client app VM.
 *
 * This gate pins the two doc surfaces that created the ambiguity so neither
 * can drift back to an unclear state without CI catching it:
 *
 * A. templates/client-repo/CLAUDE.md — the "Deploy" bullet shipped into every
 *    app author's repo. Must unambiguously state:
 *    (i)  The CONTROL PLANE deploys prod from a CI-green dated tag on main.
 *    (ii) The app author only opens PRs and cuts tags — they NEVER SSH into or
 *         run deploy commands on the app VM.
 *    (iii)"Manual deploy" means an operator running samohost on the CONTROL
 *         PLANE, not the VM.
 *
 * B. docs/stack/deploy.md — the shared stack doc. The field-record on-VM-cron
 *    passage must carry an explicit contrast note that samohost-managed apps
 *    deploy ONLY via the control-plane trigger, never via an on-VM script and
 *    never by the author SSHing in.
 *
 * These are pure static content assertions (no server, no DB, no browser).
 * Fail here → fix the doc. Do not change the assertions to fit the old text.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const REPO_ROOT = new URL("..", import.meta.url).pathname;

const TEMPLATE_PATH = `${REPO_ROOT}templates/client-repo/CLAUDE.md`;
const DEPLOY_DOC_PATH = `${REPO_ROOT}docs/stack/deploy.md`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readFile(path: string): string {
  return readFileSync(path, "utf8");
}

// Extract the Deploy bullet from the SAMO-STACK block in the template.
// The bullet is identified by the "- **Deploy**:" marker.
function extractDeployBullet(content: string): string {
  const lines = content.split("\n");
  const startIdx = lines.findIndex((l) => l.includes("**Deploy**:"));
  if (startIdx === -1) return "";
  // Collect the bullet and any continuation lines (indented or blank before next bullet)
  const parts: string[] = [lines[startIdx]!];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    // Stop at the next bullet or section
    if (line.trimStart().startsWith("- **") || line.startsWith("##") || line.startsWith("<!--")) {
      break;
    }
    parts.push(line);
  }
  return parts.join("\n");
}

// Extract the field-record section from deploy.md.
function extractFieldRecordSection(content: string): string {
  const lines = content.split("\n");
  const startIdx = lines.findIndex(
    (l) => l.includes("field-record") && (l.startsWith("###") || l.startsWith("##")),
  );
  if (startIdx === -1) return "";
  const parts: string[] = [lines[startIdx]!];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("###") || line.startsWith("##")) break;
    parts.push(line);
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// A. templates/client-repo/CLAUDE.md — Deploy bullet
// ---------------------------------------------------------------------------

describe("A. templates/client-repo/CLAUDE.md — Deploy guidance clarity", () => {
  let templateContent: string;
  let deployBullet: string;

  test("template file exists and is readable", () => {
    templateContent = readFile(TEMPLATE_PATH);
    expect(templateContent.length).toBeGreaterThan(0);
  });

  test("template contains a Deploy bullet in the SAMO-STACK block", () => {
    templateContent = readFile(TEMPLATE_PATH);
    deployBullet = extractDeployBullet(templateContent);
    expect(deployBullet.length, "No **Deploy**: bullet found in template").toBeGreaterThan(0);
  });

  // (i) Must state the CONTROL PLANE deploys — not the author, not a generic timer.
  // "control plane" (case-insensitive) must appear in the deploy bullet.
  test("(i) Deploy bullet names the CONTROL PLANE as the deployer", () => {
    templateContent = readFile(TEMPLATE_PATH);
    deployBullet = extractDeployBullet(templateContent);
    expect(
      deployBullet.toLowerCase(),
      `Deploy bullet must name 'control plane' as the deployer. Current text:\n${deployBullet}`,
    ).toContain("control plane");
  });

  // (ii) Must state the author only opens PRs / cuts tags and NEVER SSHes in or runs deploy.
  // The bullet must contain a negative statement about SSHing into the VM.
  test("(ii) Deploy bullet states the app author NEVER SSHes into or deploys on the VM", () => {
    templateContent = readFile(TEMPLATE_PATH);
    deployBullet = extractDeployBullet(templateContent);
    const lower = deployBullet.toLowerCase();
    const hasNegativeSSH =
      lower.includes("never ssh") ||
      lower.includes("do not ssh") ||
      lower.includes("you never ssh") ||
      lower.includes("not ssh into") ||
      (lower.includes("never") && lower.includes("ssh")) ||
      (lower.includes("never") && lower.includes("deploy") && lower.includes("vm"));
    expect(
      hasNegativeSSH,
      `Deploy bullet must state the author NEVER SSHes into the app VM. Current text:\n${deployBullet}`,
    ).toBe(true);
  });

  // (ii) The bullet should also state the author only opens PRs and cuts tags.
  test("(ii) Deploy bullet states the app author only opens PRs and cuts release tags", () => {
    templateContent = readFile(TEMPLATE_PATH);
    deployBullet = extractDeployBullet(templateContent);
    const lower = deployBullet.toLowerCase();
    const hasPRsAndTags =
      (lower.includes("pr") || lower.includes("pull request")) &&
      (lower.includes("tag") || lower.includes("release"));
    expect(
      hasPRsAndTags,
      `Deploy bullet must mention PRs and release tags as the author's only deploy actions. Current text:\n${deployBullet}`,
    ).toBe(true);
  });

  // (iii) "Manual deploy" clarification: must state that manual deploy means
  // an operator running samohost on the control plane, NOT the VM.
  test('(iii) Deploy bullet clarifies "manual deploy" = control-plane operator action', () => {
    templateContent = readFile(TEMPLATE_PATH);
    deployBullet = extractDeployBullet(templateContent);
    const lower = deployBullet.toLowerCase();
    // Must contain a clarification that "manual deploy" or the trigger is a
    // control-plane operation, not a VM operation. Look for "control plane" +
    // ("manual" or "operator" or "samohost app deploy").
    const hasClarification =
      lower.includes("control plane") &&
      (lower.includes("manual") ||
        lower.includes("operator") ||
        lower.includes("samohost app deploy"));
    expect(
      hasClarification,
      `Deploy bullet must clarify that 'manual deploy' is a control-plane operation. Current text:\n${deployBullet}`,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. docs/stack/deploy.md — field-record section contrast note
// ---------------------------------------------------------------------------

describe("B. docs/stack/deploy.md — field-record section must carry a contrast note", () => {
  let deployDocContent: string;
  let fieldRecordSection: string;

  test("deploy.md exists and is readable", () => {
    deployDocContent = readFile(DEPLOY_DOC_PATH);
    expect(deployDocContent.length).toBeGreaterThan(0);
  });

  test("deploy.md contains a field-record section", () => {
    deployDocContent = readFile(DEPLOY_DOC_PATH);
    fieldRecordSection = extractFieldRecordSection(deployDocContent);
    expect(
      fieldRecordSection.length,
      "No field-record section found in deploy.md",
    ).toBeGreaterThan(0);
  });

  // The field-record section must contrast its legacy on-VM cron with the
  // samohost-managed pattern.
  test("field-record section carries an explicit contrast: samohost-managed apps deploy ONLY via control-plane trigger", () => {
    deployDocContent = readFile(DEPLOY_DOC_PATH);
    fieldRecordSection = extractFieldRecordSection(deployDocContent);
    const lower = fieldRecordSection.toLowerCase();

    // Must mention it's a "legacy" or "exception" specific to field-record.
    const isMarkedLegacy =
      lower.includes("legacy") || lower.includes("exception");
    expect(
      isMarkedLegacy,
      `field-record section must mark its on-VM cron as a 'legacy' or 'exception'. ` +
        `Current text:\n${fieldRecordSection}`,
    ).toBe(true);

    // Must state that samohost-managed apps (or all other apps) deploy ONLY
    // via the control-plane trigger — not via on-VM scripts or SSH.
    const hasControlPlaneContrast =
      lower.includes("control-plane") ||
      lower.includes("control plane");
    expect(
      hasControlPlaneContrast,
      `field-record section must contrast with the control-plane-trigger model. ` +
        `Current text:\n${fieldRecordSection}`,
    ).toBe(true);

    // Must carry "never" with SSH or on-VM to make the contrast explicit.
    const hasNeverSSH =
      (lower.includes("never") && (lower.includes("ssh") || lower.includes("on-vm") || lower.includes("vm script"))) ||
      lower.includes("never via an on-vm") ||
      lower.includes("never by the author ssh");
    expect(
      hasNeverSSH,
      `field-record section must explicitly state other apps NEVER deploy via on-VM script ` +
        `or author SSH. Current text:\n${fieldRecordSection}`,
    ).toBe(true);
  });
});
