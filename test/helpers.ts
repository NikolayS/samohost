import type { ProvisionSpec } from "../src/types.ts";

/** A canonical sample SSH public key (public material — safe in fixtures). */
export const SAMPLE_PUBKEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISAMOHOSTtestkeyFIXEDvalueFORsnapshot01 samo@fixture";

/** Build a fully-defaulted spec for tests, with overrides. */
export function makeSpec(overrides: Partial<ProvisionSpec> = {}): ProvisionSpec {
  return {
    provider: "hetzner",
    region: "nbg1",
    type: "cx22",
    name: "samohost-test",
    sshKeyPath: "/home/fixture/.ssh/id_ed25519.pub",
    sshPort: 2223,
    adminUser: "samo",
    modules: [],
    trustedIps: [],
    timeoutSec: 600,
    ...overrides,
  };
}
