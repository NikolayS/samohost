# Enabling app-config heal (SAMOHOST_APP_HEAL)

The app-config heal pass is **off by default**. Merging this PR changes **zero
runtime behaviour** on prod — no code path runs until the operator explicitly
adds the env flag below.

## Pre-enable checklist

Run these checks (one per registered app) **before** adding the env key:

1. **All VMs must have the import line**
   ```
   grep 'import sites.d' /etc/caddy/Caddyfile
   ```
   Expected: `import sites.d/*.caddy`. If absent, follow
   [migrate-inline-caddyfile.md](migrate-inline-caddyfile.md) for that VM first.

2. **All node-app VMs must have the four Caddy sudoers grants**
   ```
   sudo cat /etc/sudoers.d/<app>-agent
   ```
   Expected lines (added by corrected bootstrap — re-run the sudoers section
   idempotently for any VM bootstrapped before this PR):
   ```
   <user> ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy
   <user> ALL=(root) NOPASSWD: /usr/bin/tee /etc/caddy/sites.d/*.caddy
   <user> ALL=(root) NOPASSWD: /usr/bin/mv -- /etc/caddy/sites.d/*.caddy /etc/caddy/sites.d/*.caddy
   <user> ALL=(root) NOPASSWD: /usr/bin/rm -f /etc/caddy/sites.d/*.caddy
   ```

3. **Dry-run proves no unexpected drift**
   ```
   samohost app heal <vm> <app>   # no --apply → dry-run
   ```
   Inspect the generated script. Confirm no `sudo tee` to a `/tmp` path.

4. **Supervised heal per app** (after migration)
   ```
   samohost app heal <vm> <app> --apply --json
   ```
   Expected outcome: `no-drift` or `adopted`. Then re-run — must be `no-drift`
   (idempotence proof).

5. **HTTP 200 confirmation per app** after each heal run.

6. **game-changers** (if registered): must have a `deployedSha` before heal
   will attempt it. Owner decides: deploy properly or leave (heal correctly
   skips apps with no `deployedSha`).

## Enabling

Once all VMs pass the checklist, on the control-plane VM:

```sh
echo 'SAMOHOST_APP_HEAL=1' >> /etc/samohost/trigger.env
```

Watch one manual trigger cycle and inspect the JSON report:

```sh
samohost trigger run --app-heal --json
```

Expected: every app shows `no-drift` in the `appHeal` array. Zero Caddy reloads.

## Tuning the cap

Default cap = 2 VMs per cycle. Once confidence exists:

```sh
echo 'SAMOHOST_HEAL_VM_CAP=10' >> /etc/samohost/trigger.env
```

## Rollback

Remove the env key:

```sh
sed -i '/SAMOHOST_APP_HEAL/d' /etc/samohost/trigger.env
```

The next timer cycle skips the heal pass entirely. No in-flight loop to kill
(trigger is a one-shot systemd unit).
