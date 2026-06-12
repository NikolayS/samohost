# samohost

`samohost` is an operator-local TypeScript/Bun CLI that provisions and manages
security-hardened Linux VMs (Hetzner Cloud in v0.1; AWS deferred), deploys apps
onto them, and stands up per-git-branch preview environments — with the full
hardening baseline baked into every VM and all state kept on your own machine.
There is no server to run and provider credentials never leave the operator host.

## Install / run

Requires [Bun](https://bun.sh). From a clone of this repo:

```bash
bun install
bun run src/cli.ts --help          # or: bun run src/cli.ts <command>
```

State lives at `~/.samohost/` (VMs, apps, envs, pinned host keys). Provider
credentials come from the environment: `HCLOUD_TOKEN` for Hetzner.

## Command surface

Every command supports `--json`. Read-only commands make no provider calls
unless noted.

```bash
# Provision / teardown a hardened VM (real Hetzner API; needs HCLOUD_TOKEN)
samohost provision --provider hetzner --region nbg1 --type cx23 --name web --ssh-key ~/.ssh/id_ed25519
samohost destroy web                       # typed-name confirmation unless --yes; volumes reported, never deleted
samohost preview --provider hetzner --region nbg1 --type cx23 --ssh-pubkey @~/.ssh/id_ed25519.pub  # render cloud-init only, no API call

# Adopt an existing VM into state (no provider call; host key pinned at adopt time)
samohost adopt --name web --ip 10.0.0.5 --ssh-user samo --ssh-key ~/.ssh/id_ed25519 --host-key-fingerprint 'SHA256:…'

# Observe
samohost list
samohost status web --audit                # SSHes in, runs read-only hardening probes (pass/fail/unknown)

# Deploy an app (CI-gated, RLS-checked, env-file sourced, rollback-safe)
samohost app register web --name field-record --repo owner/repo --service-unit field-record --health-url http://127.0.0.1:3000/api/version --env-file /opt/app/staging.env --assert-rls --rls-url-var APP_DATABASE_URL
samohost app plan web field-record --sha <sha>     # print the deploy script, no execution
samohost app deploy web field-record --sha <sha>   # CI-green gate; --skip-ci-gate / --force to override
samohost app status web field-record
samohost app clear-failed web field-record         # clear a recorded known-bad SHA

# Per-branch preview environments (vhost <app>-<branch>.<domain>, own DB per env)
samohost env preflight web                          # is the DBLab engine / template fallback ready?
samohost env plan web field-record --host-prep      # render the one-time root host-prep for review
samohost env create web field-record --branch feat/x --db dblab   # or --db template | none
samohost env list web
samohost env destroy web field-record --branch feat/x

# Preview DNS preflight (read-only)
samohost dns status example.com --expect-ip 10.0.0.5 --cf-zone example.com
```

## 5-minute quickstart (adopt → deploy)

For an existing hardened VM with a non-root sudo user on a custom SSH port:

```bash
# 1. Adopt it (verify the fingerprint out-of-band first; it is pinned for all later SSH)
samohost adopt --name web --ip <ip> --ssh-user samo --ssh-key ~/.ssh/id_ed25519 \
  --host-key-fingerprint 'SHA256:…'
samohost status web --audit                         # confirm the hardening baseline

# 2. Register the app once (mirrors your deploy.sh), then deploy a SHA
samohost app register web --name myapp --repo owner/repo \
  --service-unit myapp --health-url http://127.0.0.1:3000/api/version \
  --env-file /opt/myapp/app.env --assert-rls --rls-url-var APP_DATABASE_URL
samohost app deploy web myapp --sha <sha>           # fetch → build → migrate → restart → health → RLS probe
```

`provision` instead of `adopt` gives you the VM too, from one command.

## How it's tested

- **Unit + golden/snapshot:** `bun test` (385 tests; rendered deploy/env scripts
  are snapshot-pinned so a contract change is a visible diff). Typecheck with
  `bunx tsc --noEmit`. CI runs both on every PR.
- **Executed validation:** write-path changes are re-run end-to-end in a
  disposable Docker sandbox before any real host, and the whole lifecycle
  (`provision → status --audit → app deploy → env create → destroy`) has been
  run against a real Hetzner VM with zero-orphan teardown. samohost deployed
  its first production app and first live preview environment this way.

## Design

See [SPEC.md](SPEC.md) for the architecture, lifecycle state machine, and the
provider/module abstractions, and [SPEC-DELTA.md](SPEC-DELTA.md) for the
adopt/app/env/provision amendments driven by real deployments.
