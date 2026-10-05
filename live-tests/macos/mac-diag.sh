#!/bin/bash
# Raw evidence for the macOS failures: run the exact JXA / AppleScript calls
# the adapter makes and print what they return (the adapter swallows errors).
J=scripts/mac
PID=$(pgrep -x cctarget)
echo "cctarget pid=$PID frontmost=$(osascript -e 'tell application "System Events" to get name of first process whose frontmost is true')"
run() { echo "--- $1"; shift; "$@" 2>&1 | head -c 700; echo; }
run "invoke click Charlie (pid)"        osascript -l JavaScript $J/invoke-element.jxa -- -ProcessId $PID -Name Charlie -Action click
run "set-value First name (pid)"        osascript -l JavaScript $J/invoke-element.jxa -- -ProcessId $PID -Name "First name" -Action set-value -Value Zed
run "set-value First name, Edit role"   osascript -l JavaScript $J/invoke-element.jxa -- -ProcessId $PID -Name "First name" -ControlType Edit -Action set-value -Value Zed
run "get-value First name, Edit role"   osascript -l JavaScript $J/invoke-element.jxa -- -ProcessId $PID -Name "First name" -ControlType Edit -Action get-value
run "toggle Subscribe"                  osascript -l JavaScript $J/invoke-element.jxa -- -ProcessId $PID -Name Subscribe -Action toggle
run "checkbox value after toggle"       osascript -e "tell application \"System Events\" to tell (first process whose unix id is $PID) to get value of checkbox \"Subscribe\" of window \"CC Target\""
run "find First name"                   osascript -l JavaScript $J/find-element.jxa -- -ProcessId $PID -Name "First name"
run "find Row 05 (visible)"             osascript -l JavaScript $J/find-element.jxa -- -ProcessId $PID -Name "Row 05"
run "find Row 50 (offscreen)"           osascript -l JavaScript $J/find-element.jxa -- -ProcessId $PID -Name "Row 50"
run "AX names of the text fields"       osascript -e "tell application \"System Events\" to tell (first process whose unix id is $PID) to get {name, description, role} of every text field of window \"CC Target\""
run "window clause (fixed form)"        osascript -e 'tell application "System Events" to tell (first window of (first application process whose (count of (windows whose title contains "CC Target")) > 0) whose title contains "CC Target") to get {position, size}'
run "window clause (old form)"          osascript -e 'tell application "System Events" to tell first window whose title contains "CC Target" of (first application process whose frontmost is true) to get position'
echo "--- row events in target log"; grep '"row"' /tmp/cc-target.log | head -5
