#!/bin/bash
# Pre-grant macOS privacy permissions for a CI run (GitHub macOS images allow
# writing TCC.db). macOS attributes a permission to the "responsible" process,
# so grant every ancestor of this shell plus the tools clawdcursor spawns.
set -u
SYS_DB="/Library/Application Support/com.apple.TCC/TCC.db"
USR_DB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"

clients=()
pid=$$
while [ "$pid" -gt 1 ]; do
  exe=$(ps -o comm= -p "$pid" 2>/dev/null | sed 's/^ *//')
  [ -n "$exe" ] && [ -e "$exe" ] && clients+=("$exe")
  pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
  [ -z "$pid" ] && break
done
clients+=("$(command -v node)" "$(readlink -f "$(command -v node)" 2>/dev/null || true)" /bin/bash /bin/zsh /bin/sh /usr/bin/osascript /usr/sbin/screencapture)
for b in ClawdCursorHelper screenshot-helper permission-check ClawdCursorHost; do
  [ -e "$PWD/native/ClawdCursor.app/Contents/MacOS/$b" ] && clients+=("$PWD/native/ClawdCursor.app/Contents/MacOS/$b")
done

insert() { # db service client client_type indirect
  sudo sqlite3 "$1" "INSERT OR REPLACE INTO access (service,client,client_type,auth_value,auth_reason,auth_version,csreq,policy_id,indirect_object_identifier_type,indirect_object_identifier,indirect_object_code_identity,flags,last_modified) VALUES ('$2','$3',$4,2,4,1,NULL,NULL,0,'$5',NULL,0,strftime('%s','now'));" 2>&1 | head -1
}
for c in $(printf '%s\n' "${clients[@]}" | awk 'NF && !seen[$0]++'); do
  for s in kTCCServiceAccessibility kTCCServiceScreenCapture kTCCServicePostEvent kTCCServiceListenEvent; do
    insert "$SYS_DB" "$s" "$c" 1 UNUSED; insert "$USR_DB" "$s" "$c" 1 UNUSED
  done
  for target in com.apple.systemevents com.apple.TextEdit com.apple.finder; do
    insert "$USR_DB" kTCCServiceAppleEvents "$c" 1 "$target"
  done
  echo "granted: $c"
done
for s in kTCCServiceAccessibility kTCCServiceScreenCapture kTCCServicePostEvent; do
  insert "$SYS_DB" "$s" com.clawdcursor.helper 0 UNUSED
done
echo "system TCC rows: $(sudo sqlite3 "$SYS_DB" 'select count(*) from access' 2>&1)"
