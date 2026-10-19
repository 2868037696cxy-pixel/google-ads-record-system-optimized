#!/usr/bin/env bash
# Idempotent, isolated upgrade. No firewall, VNC, Hermes or cloudflared changes.
set -Eeuo pipefail
umask 077
[[ $(id -u) == 0 ]] || { echo 'Run with sudo bash scripts/deploy-ubuntu.sh'; exit 1; }
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
for tool in git tar python3 systemctl runuser flock; do command -v "$tool" >/dev/null || { echo "Missing tool: $tool"; exit 1; }; done
NODE=''
for candidate in /usr/local/bin/node "$(command -v node || true)" /usr/bin/node; do
  if [[ -x "$candidate" ]] && "$candidate" -e 'const s=require("node:sqlite");if(!s.backup)process.exit(1)' >/dev/null 2>&1; then NODE="$candidate"; break; fi
done
[[ -n "$NODE" ]] || { echo 'Need a Node.js runtime with node:sqlite backup (Node 22.16+ or 24).'; exit 1; }
export PATH="$(dirname "$NODE"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
NPM=$(command -v npm)
[[ -f "$SOURCE/server.js" && -f "$SOURCE/package-lock.json" ]] || { echo 'Incomplete source'; exit 1; }
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
COMMIT=$(git -C "$SOURCE" rev-parse --short=12 HEAD 2>/dev/null || echo "source-$STAMP")
RELEASE="/opt/adsworkbench-releases/$COMMIT-$STAMP"
DATA=/var/lib/adsworkbench
BACKUPS=/var/backups/adsworkbench
# Budget for a staged release plus backup/migration copies before touching the service.
python3 - "$DATA" <<'PYSPACE'
import shutil,sys,os
p=sys.argv[1]; base=p if os.path.isdir(p) else '/var/lib'
db=os.path.join(p,'workbench.sqlite'); size=os.path.getsize(db) if os.path.exists(db) else 0
if shutil.disk_usage(base).free < size*4+2*1024**3:
 raise SystemExit('Insufficient disk space for a safe staged upgrade and rollback. No service changes made.')
PYSPACE
UNIT=/etc/systemd/system/adsworkbench.service
BACKUP_UNIT=/etc/systemd/system/adsworkbench-backup.service
BACKUP_TIMER=/etc/systemd/system/adsworkbench-backup.timer
ENVFILE=/etc/adsworkbench.env
CURRENT=/opt/adsworkbench-current
id adsworkbench >/dev/null 2>&1 || useradd --system --home "$DATA" --create-home --shell /usr/sbin/nologin adsworkbench
install -d -m 700 -o adsworkbench -g adsworkbench "$DATA" "$BACKUPS"
LOCKFILE="$DATA/.maintenance.lock"
touch "$LOCKFILE"; chown adsworkbench:adsworkbench "$LOCKFILE"; chmod 600 "$LOCKFILE"
exec 9>"$LOCKFILE"
flock -n 9 || { echo 'Another Ads Workbench deployment/backup operation is already running; no changes made.'; exit 1; }
install -d -m 755 /opt/adsworkbench-releases
install -d -m 755 "$RELEASE"
# The archive excludes all live databases, keys, development dependencies and artifacts.
tar -C "$SOURCE" --exclude=.git --exclude=node_modules --exclude=data --exclude=dist --exclude=backups --exclude='*.sqlite*' --exclude='*.log' -cf - . | tar -C "$RELEASE" -xf -
chown -R adsworkbench:adsworkbench "$RELEASE"
cd "$RELEASE"
runuser -u adsworkbench -- env PATH="$PATH" "$NPM" ci --omit=dev --ignore-scripts --cache "$RELEASE/.npm-cache"
runuser -u adsworkbench -- env -u ADS_SECRETS_KEY_FILE -u PUBLIC_ORIGIN NODE_ENV=test PATH="$PATH" "$NODE" --test --test-concurrency=1 tests/*.test.js
rm -rf -- "$RELEASE/.npm-cache"
chown -R root:root "$RELEASE"
install -d -m 750 -o root -g adsworkbench /etc/adsworkbench
KEY=/etc/adsworkbench/secret.key
# Reuse the existing key, including a previously configured external key file.
EXISTING_KEY=$(python3 - "$ENVFILE" <<'PYKEY'
import sys,os
p=sys.argv[1]
if os.path.exists(p):
 for line in open(p):
  if line.startswith('ADS_SECRETS_KEY_FILE='):
   print(line.split('=',1)[1].strip().strip('\"\''));break
PYKEY
)
if [[ -n "$EXISTING_KEY" && "$EXISTING_KEY" != "$KEY" ]]; then
  [[ -f "$EXISTING_KEY" ]] || { echo 'Configured encryption key is missing. Refusing replacement.'; exit 1; }
  if [[ -f "$KEY" ]]; then cmp -s "$KEY" "$EXISTING_KEY" || { echo 'Different encryption keys detected; resolve before upgrade.'; exit 1; };
  else install -m 640 -o root -g adsworkbench "$EXISTING_KEY" "$KEY"; fi
fi
if [[ ! -f "$KEY" ]]; then
  if [[ -f "$DATA/.secrets.key" ]]; then install -m 640 -o root -g adsworkbench "$DATA/.secrets.key" "$KEY";
  else
    "$NODE" -e 'const f=require("node:fs"),p=process.argv[1];if(f.existsSync(p)){const d=new(require("node:sqlite").DatabaseSync)(p,{readOnly:true});const meta=d.prepare("SELECT name FROM sqlite_master WHERE type=? AND name=?").get("table","meta");if(meta&&d.prepare("SELECT value FROM meta WHERE key=?").get("vault_key_id"))throw new Error("Existing encrypted database has lost its key; refusing replacement");d.close();}' "$DATA/workbench.sqlite"
    "$NODE" -e 'require("node:fs").writeFileSync(process.argv[1],require("node:crypto").randomBytes(32).toString("hex")+"\n",{mode:0o640,flag:"wx"})' "$KEY";chown root:adsworkbench "$KEY";fi
fi
chmod 640 "$KEY";chown root:adsworkbench "$KEY"
"$NODE" -e 'const f=require("node:fs"),c=require("node:crypto");const k=f.readFileSync(process.argv[1],"utf8").trim();if(!/^[a-f0-9]{64}$/i.test(k))throw new Error("Invalid encryption key");const p=process.argv[2];if(f.existsSync(p)){const d=new(require("node:sqlite").DatabaseSync)(p,{readOnly:true});if(d.prepare("SELECT name FROM sqlite_master WHERE type=? AND name=?").get("table","meta")){const m=d.prepare("SELECT value FROM meta WHERE key=?").get("vault_key_id");if(m&&m.value!==c.createHash("sha256").update(Buffer.from(k,"hex")).digest("hex"))throw new Error("Encryption key does not match existing database");}d.close();}' "$KEY" "$DATA/workbench.sqlite"
ENV_EXISTED=0; UNIT_EXISTED=0; BACKUP_UNIT_EXISTED=0; BACKUP_TIMER_EXISTED=0; CURRENT_EXISTED=0
[[ -f "$ENVFILE" ]] && { ENV_EXISTED=1; cp -p "$ENVFILE" "/etc/adsworkbench/env-before-$STAMP"; }
[[ -f "$UNIT" ]] && { UNIT_EXISTED=1; cp -p "$UNIT" "/etc/adsworkbench/unit-before-$STAMP"; }
[[ -f "$BACKUP_UNIT" ]] && { BACKUP_UNIT_EXISTED=1; cp -p "$BACKUP_UNIT" "/etc/adsworkbench/backup-unit-before-$STAMP"; }
[[ -f "$BACKUP_TIMER" ]] && { BACKUP_TIMER_EXISTED=1; cp -p "$BACKUP_TIMER" "/etc/adsworkbench/backup-timer-before-$STAMP"; }
CURRENT_TARGET=''
if [[ -L "$CURRENT" ]]; then CURRENT_EXISTED=1; CURRENT_TARGET=$(readlink "$CURRENT")
elif [[ -e "$CURRENT" ]]; then echo "$CURRENT exists but is not a symlink; refusing upgrade."; exit 1
fi
ROLLBACK=''
WAS_ACTIVE=0; WAS_ENABLED=0; WAS_TIMER_ACTIVE=0; WAS_TIMER_ENABLED=0
systemctl is-active --quiet adsworkbench && WAS_ACTIVE=1
systemctl is-enabled --quiet adsworkbench 2>/dev/null && WAS_ENABLED=1
systemctl is-active --quiet adsworkbench-backup.timer && WAS_TIMER_ACTIVE=1
systemctl is-enabled --quiet adsworkbench-backup.timer 2>/dev/null && WAS_TIMER_ENABLED=1
rollback() {
  trap - ERR
  set +e
  echo 'Upgrade failed; retaining release and restoring the previous service/data when available.'
  systemctl stop adsworkbench-backup.timer || true
  systemctl stop adsworkbench-backup.service || true
  systemctl stop adsworkbench || true
  if [[ -n "$ROLLBACK" && -f "$ROLLBACK" ]]; then
    "$NODE" "$RELEASE/scripts/backup.cjs" restore "$ROLLBACK" "$DATA/rollback-$STAMP.sqlite" || { echo "Automatic data restoration failed; service remains stopped. Preserve original database and key."; return 1; }
    [[ -f "$DATA/workbench.sqlite" ]] && mv "$DATA/workbench.sqlite" "$DATA/failed-upgrade-$STAMP.sqlite" || true
    rm -f -- "$DATA/workbench.sqlite-wal" "$DATA/workbench.sqlite-shm"
    mv "$DATA/rollback-$STAMP.sqlite" "$DATA/workbench.sqlite";chown adsworkbench:adsworkbench "$DATA/workbench.sqlite"
  fi
  if [[ "$ENV_EXISTED" == 1 ]]; then cp -p "/etc/adsworkbench/env-before-$STAMP" "$ENVFILE"; else rm -f -- "$ENVFILE"; fi
  if [[ "$UNIT_EXISTED" == 1 ]]; then cp -p "/etc/adsworkbench/unit-before-$STAMP" "$UNIT"; else rm -f -- "$UNIT"; fi
  if [[ "$BACKUP_UNIT_EXISTED" == 1 ]]; then cp -p "/etc/adsworkbench/backup-unit-before-$STAMP" "$BACKUP_UNIT"; else rm -f -- "$BACKUP_UNIT"; fi
  if [[ "$BACKUP_TIMER_EXISTED" == 1 ]]; then cp -p "/etc/adsworkbench/backup-timer-before-$STAMP" "$BACKUP_TIMER"; else rm -f -- "$BACKUP_TIMER"; fi
  if [[ "$CURRENT_EXISTED" == 1 ]]; then ln -sfn "$CURRENT_TARGET" "$CURRENT"; else rm -f -- "$CURRENT"; fi
  systemctl daemon-reload
  if [[ "$WAS_ENABLED" == 1 ]]; then systemctl enable adsworkbench >/dev/null 2>&1 || true; else systemctl disable adsworkbench >/dev/null 2>&1 || true; fi
  if [[ "$WAS_TIMER_ENABLED" == 1 ]]; then systemctl enable adsworkbench-backup.timer >/dev/null 2>&1 || true; else systemctl disable adsworkbench-backup.timer >/dev/null 2>&1 || true; fi
  if [[ "$WAS_TIMER_ACTIVE" == 1 ]]; then systemctl start adsworkbench-backup.timer || true; else systemctl stop adsworkbench-backup.timer || true; fi
  if [[ "$WAS_ACTIVE" == 1 ]]; then systemctl start adsworkbench || true; else systemctl stop adsworkbench || true; fi
}
failpoint() {
  if [[ "${ADS_DEPLOY_TEST_FAILPOINT:-}" == "$1" ]]; then
    echo "Injected deployment failure at $1 (test hook)."
    return 1
  fi
}
trap 'rollback; exit 1' ERR
# Preserve existing invitation and unrelated values; never echo secrets.
python3 - "$ENVFILE" "$KEY" <<'PY'
import sys,secrets,os
p,key=sys.argv[1:]; values={}
if os.path.exists(p):
 for line in open(p):
  if '=' in line and not line.lstrip().startswith('#'):
   k,v=line.rstrip('\n').split('=',1);values[k]=v
values.update(NODE_ENV='production',HOST='127.0.0.1',PORT='4317',DATA_DIR='/var/lib/adsworkbench',DB_FILE='/var/lib/adsworkbench/workbench.sqlite',ADS_SECRETS_KEY_FILE=key,SESSION_SECURE='1',PUBLIC_ORIGIN='https://ads.fbsoso.xin',TRUST_CLOUDFLARE='1',DEDUP_ADDRESS_MODE='warn',BACKUP_DIR='/var/backups/adsworkbench',BACKUP_KEEP='7')
values.setdefault('REGISTRATION','invite')
if not values.get('INVITE_CODE') or values['INVITE_CODE'].startswith('REPLACE_'):values['INVITE_CODE']=secrets.token_urlsafe(32)
temp=p+'.new';open(temp,'w').write(''.join(k+'='+v+'\n' for k,v in values.items()));os.chmod(temp,0o600);os.replace(temp,p)
PY
if [[ $WAS_ACTIVE == 1 ]]; then systemctl stop adsworkbench; fi
if [[ -f "$DATA/workbench.sqlite" ]]; then
  "$NODE" "$RELEASE/scripts/backup.cjs" create "$BACKUPS" > "/etc/adsworkbench/backup-$STAMP.json"
  ROLLBACK=$("$NODE" -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).backup' "/etc/adsworkbench/backup-$STAMP.json")
fi
cat > "$UNIT" <<EOF
[Unit]
Description=Ads Workbench central backend
After=network.target
[Service]
Type=simple
User=adsworkbench
Group=adsworkbench
WorkingDirectory=$RELEASE
EnvironmentFile=$ENVFILE
ExecStart=$NODE $RELEASE/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$DATA
PrivateTmp=yes
UMask=0077
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
if ! systemctl enable --now adsworkbench; then rollback; exit 1; fi
GOOD=0
for n in $(seq 1 30); do
  if "$NODE" -e 'fetch("http://127.0.0.1:4317/api/healthz").then(r=>{if(!r.ok)throw new Error();return r.json()}).then(d=>process.exit(d.version==="1.2.0"?0:1)).catch(()=>process.exit(1))' >/dev/null 2>&1; then GOOD=1; break; fi
  sleep 1
done
if [[ $GOOD != 1 ]]; then rollback; exit 1; fi
ln -sfn "$RELEASE" "$CURRENT"
failpoint after-current-link
cat > "$BACKUP_UNIT" <<EOF
[Unit]
Description=Encrypted Ads Workbench database backup
[Service]
Type=oneshot
User=adsworkbench
Group=adsworkbench
EnvironmentFile=$ENVFILE
ExecStart=/usr/bin/flock -w 300 $LOCKFILE $NODE $RELEASE/scripts/backup.cjs create $BACKUPS
NoNewPrivileges=yes
ProtectSystem=strict
ReadWritePaths=$DATA $BACKUPS
PrivateTmp=yes
UMask=0077
EOF
cat > "$BACKUP_TIMER" <<'EOF'
[Unit]
Description=Daily Ads Workbench encrypted backup
[Timer]
OnCalendar=*-*-* 03:30:00
RandomizedDelaySec=900
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now adsworkbench-backup.timer
failpoint after-backup-units
trap - ERR
echo "Upgrade verified. Release: $RELEASE"
echo 'Only adsworkbench was restarted. Keep the encryption key separate from off-site backups.'
echo 'Backup timer is enabled; configure an OFF-SERVER destination before real data rollout.'
systemctl is-active adsworkbench
