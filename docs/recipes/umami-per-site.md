# Umami per-site analytics recipe

Onboards a self-hosted [Umami](https://umami.is) analytics instance for a single client site onto an existing samohost-managed VM.  Each site gets its **own** Umami app record, its own managed Postgres database, and its own Caddy `mainHost` vhost — everything lives on the client project VM.

---

## Inputs

| Flag | Required | Description |
|---|---|---|
| `--vm` | yes | VM name or id (must be adopted/provisioned) |
| `--site` | yes | Short slug, e.g. `acme` — derives `name`, `dbName`, `appUser` |
| `--host` | yes | Public FQDN for the Umami dashboard, e.g. `analytics.acme.com` |
| `--port` | yes | TCP port Umami's standalone server will bind to, e.g. `3100` |
| `--umami-repo` | yes | GitHub `owner/name` of the Umami deploy repo (must contain prebuilt standalone) |
| `--umami-ref` | no | Git branch/ref to track (default: `v3`) |

Derived identifiers:

- **name**: `umami-<slug>` (e.g. `umami-acme`)
- **dbName**: `umami_<slug>` with hyphens converted to underscores (e.g. `umami_acme`)
- **appUser**: `umami-<slug>` (truncated to 32 chars to satisfy Linux username limit)

---

## Off-VM artifact build requirement

Umami's Next.js build **must not run on the VM**.  A cx23 has ~2 GB RAM and will OOM during `next build`.

The `umami-repo` referenced by `--umami-repo` must be a **dedicated deploy repository** that contains a pre-built Umami standalone artifact committed under `.next/standalone/` (or equivalent).  The manifest sets `buildCmd="/usr/bin/true"` so samohost skips the build step and only clones, links, and restarts the systemd unit.

**Building the artifact (operator, off-VM):**

```sh
# On a build machine with >= 4 GB RAM and Node 20+:
git clone https://github.com/umami-software/umami.git
cd umami
git checkout v3          # or the ref you're pinning
npm install
npm run build

# The standalone output is in .next/standalone/
# Commit it to your deploy repo:
cd /path/to/umami-deploy
cp -r /path/to/umami/.next/standalone .next/standalone
cp -r /path/to/umami/.next/static .next/standalone/.next/static
cp -r /path/to/umami/public .next/standalone/public
git add .next/standalone
git commit -m "chore: update Umami standalone artifact"
git push
```

The deploy repo is a **prerequisite** for using this recipe.  It is not created by samohost.

---

## APP_SECRET vs COOKIE_SECRET

Umami requires its own secret for signing authentication tokens.  This is **distinct** from the `COOKIE_SECRET` that samohost's bootstrap writes for its own session handling.

- `COOKIE_SECRET` — written by `samohost app bootstrap`; used by samohost internals.
- `APP_SECRET` — **must be added by the operator** after bootstrap; used by Umami.

**Do not reuse `COOKIE_SECRET` as `APP_SECRET`.**  They serve different purposes and must be independent values.

Add `APP_SECRET` after bootstrap:

```sh
# On the VM, as root or the app user:
echo "APP_SECRET=$(openssl rand -hex 32)" >> /opt/umami-<slug>/staging.env
# Restart the unit to pick up the new value:
systemctl restart umami-<slug>
```

---

## Step-by-step operator runbook

### 1. Register the app

```sh
samohost recipe umami-site \
  --vm <vm-name> \
  --site <slug> \
  --host <analytics.yourdomain.com> \
  --port <port> \
  --umami-repo <owner/umami-deploy-repo> \
  [--umami-ref v3]
```

This registers the AppRecord and prints the next steps.

### 2. Bootstrap (one-time, as root on the VM)

```sh
samohost app bootstrap <vm> umami-<slug> \
  --app-user umami-<slug> \
  --db-name umami_<slug>
```

This creates the OS user, the Postgres database, the env file skeleton, clones the repo, and installs the systemd unit.

### 3. Add APP_SECRET

```sh
echo "APP_SECRET=$(openssl rand -hex 32)" >> /opt/umami-<slug>/staging.env
```

### 4. Deploy

```sh
samohost app deploy <vm> umami-<slug>
```

### 5. Change default admin password

On first login:

1. Open `https://<host>` in a browser.
2. Log in with the default credentials: **username** `admin`, **password** `umami`.
3. Navigate to **Settings → Profile → Change password** and set a strong password immediately.

Leaving the default password active is a security risk.

### 6. Add the tracking snippet

1. In Umami: **Settings → Websites → Add Website**.
2. Copy the generated `<script>` tag.
3. Add it to the target site's HTML `<head>`.

---

## Per-site DB backup

Each Umami instance has its own Postgres database (`umami_<slug>`).  Include it in your VM-level backup policy:

```sh
# Example cron on the VM (adapt to your backup destination):
pg_dump umami_<slug> | gzip > /backups/umami_<slug>_$(date +%Y%m%d).sql.gz
```

---

## PG18 / Prisma compatibility note

Umami uses Prisma as its ORM.  As of Umami v3, Prisma support for PostgreSQL 18 must be runtime-verified at first deploy:

- If Umami fails to start with a Prisma engine error referencing PG version, check the Umami release notes for the minimum required `prisma` package version.
- Pin the Prisma version in your deploy repo's `package.json` if necessary, rebuild the standalone artifact, and redeploy.
- This is a one-time verification step per VM; once confirmed working, subsequent deploys are unaffected.

---

## Merge gate

This capability must satisfy the samohost merge gate before any client deploy:

- **M1**: green pipeline on the MR head (`refs/merge-requests/<iid>/head`)
- **M2**: `samorev PASS` from the independent reviewer

Do **not** deploy to a live VM until the feature is merged and versioned.
