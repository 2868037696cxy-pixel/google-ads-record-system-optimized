# Ads Workbench 1.2 - central private-account desktop release

## What this release changes

The installed Windows application connects to https://ads.fbsoso.xin by default. Employees do not need environment variables, additional VPN clients, or local database setup. Packaged builds cannot silently select the old standalone database mode. Development-only local mode remains available for regression testing.

Each member has an independent account. There is no shared administrator password or privileged first signup. Operators can create/reset/disable members on the server without browsing their records. Personal data isolation is enforced at the API boundary, not just in the interface.

### Security and integrity

- The database encrypts email passwords, 2FA seeds, proxy passwords, identification fields, and PDF original bytes with AES-256-GCM. The key is kept outside the database; losing it makes encrypted data unrecoverable.
- Default APIs redact credentials. Revealing or deliberately exporting them requires the current login password; the grant expires after 60 seconds and is revoked on logout, password change, or manual locking.
- Payment records accept provider references/aliases, last four digits, and expiry only. Full card numbers and CVV/CVC are not accepted. Existing supported card fields are migrated to references; legacy CVV values are cleared. This is NOT a PCI certification or an independent security audit.
- Exact-PDF hashes are globally unique across members and remain reserved after deletion. Renaming a file, submitting concurrently, or restoring another member's backup cannot bypass this rule. Different scans still require validated business identity checks; image-based identity is not infallible.
- Mutating requests use server-authenticated identity. The UI uses record versions to prevent lost updates and an idempotency key for creation retries.
- Personal backup envelopes are encrypted, authenticated, bound to their owner and server key, and cannot be imported by another member. Full server backups are encrypted, streaming SQLite snapshots, not copies of a live WAL file.
- Unknown source files, keys and database paths are never served by the static endpoint. The deprecated static dependency has been removed.

## Upgrade the existing Ubuntu server

Review the tested commit in PR #3. Keep a separate copy of the existing configuration and business data. From a clean checkout of that commit:

```bash
sudo bash scripts/deploy-ubuntu.sh
```

The installer detects a suitable Node executable (including /usr/local/bin/node), stages production dependencies, runs server tests before replacing the service, reuses the existing encryption key, takes a verified encrypted snapshot, and upgrades ONLY adsworkbench. It does not change SSH, VNC, Hermes, OpenCraft, cloudflared, DNS, or firewalls. The API remains on 127.0.0.1:4317. Startup verification failure triggers service/data rollback.

The installed source is in `/opt/adsworkbench-releases/<revision>-<timestamp>`; `/opt/adsworkbench-current` points at the successful release. The original `/opt/adsworkbench` checkout is retained. Do not run npm install with unreviewed audit-force changes against the live release.

Private server key: `/etc/adsworkbench/secret.key` (root:adsworkbench, 0640).
Environment: `/etc/adsworkbench.env` (root, 0600).
Live database and encrypted PDFs: `/var/lib/adsworkbench/workbench.sqlite`.
Verified daily encrypted snapshots: `/var/backups/adsworkbench`, seven retained by default.

Back up the encryption key in a SEPARATE secure location. Daily local snapshots alone are not disaster recovery: the operator must copy `.awbdb` snapshots to an independently controlled off-server destination. This repository does not have cloud-storage credentials and cannot configure that destination automatically.

Check:

```bash
sudo systemctl is-active adsworkbench cloudflared
sudo systemctl is-enabled adsworkbench-backup.timer
curl --fail http://127.0.0.1:4317/api/healthz
curl --fail https://ads.fbsoso.xin/api/healthz
```

Expected API version is 1.2.0. Old 1.1 servers do not implement the new unlock/encrypted-backup endpoints. Upgrade the server before distributing the new desktop client.

## Member operations

Use a private 0600 password file; never put a password directly in a shell command or chat. For example, create the file with a trusted editor, then:

```bash
sudo /usr/local/bin/node /opt/adsworkbench-current/scripts/account.cjs create alice /root/private-password-file
sudo /usr/local/bin/node /opt/adsworkbench-current/scripts/account.cjs reset alice /root/private-password-file
sudo /usr/local/bin/node /opt/adsworkbench-current/scripts/account.cjs disable alice
sudo /usr/local/bin/node /opt/adsworkbench-current/scripts/account.cjs enable alice
```

Delete the temporary password file after use. Invitation registration can remain enabled during onboarding; set `REGISTRATION=closed` in the server environment and restart ONLY adsworkbench after onboarding if operator-created accounts are preferred. Existing sessions are revoked when disabling an account or resetting its password.

## Backups and restoration

```bash
sudo /usr/local/bin/node /opt/adsworkbench-current/scripts/backup.cjs create
sudo /usr/local/bin/node /opt/adsworkbench-current/scripts/backup.cjs verify /path/to/file.awbdb
sudo /usr/local/bin/node /opt/adsworkbench-current/scripts/backup.cjs restore /path/to/file.awbdb /path/to/NEW.sqlite
```

Restore refuses to overwrite an existing database. Restore to an isolated path, verify the result, stop the service for the controlled replacement, and preserve the previous database and key. Do not attempt a live overwrite. Backup restoration, key loss, tampering and wrong-owner imports have automated regression tests.

## Windows installation and first run

Use the CI `AdsWorkbench-Windows-x64` artifact: EXE installer, portable ZIP and SHA256SUMS. The server endpoint is already included. TLS certificate failures show a retry page; certificates are not bypassed in packaged builds. Downloads use a native Save dialog; canceled or interrupted downloads are not reported as completed.

Builds in this repository are currently unsigned. No commercial code-signing certificate is present. Verify artifact hashes and use your organization's normal application review; do not disable Windows protection to bypass an unverified binary.

## Verification scope and limitations

Linux tests cover isolation, encryption, migrations, idempotency, conflicts, three-member duplicate checks, sensitive exports, password/session revocation and encrypted restoration. Windows smoke tests drive the actual Electron interface in local development mode and against a synthetic HTTPS server, including offline recovery and invalid-certificate rejection. No production credentials, actual licenses, or live user data are used.

The local HTTPS certificate and private key are generated temporarily on the test runner and removed after testing. No test private key is committed or bundled. The test-only certificate pin is disabled for packaged builds.

This release is still a single-server SQLite architecture. It does not promise unlimited simultaneous users or image-based recognition of every differently scanned document. The installer's free-space check and verified backup retention limit reduce disk exhaustion risk but do not replace capacity monitoring. Production workload tests and an independent security assessment are outside the automated CI scope.
