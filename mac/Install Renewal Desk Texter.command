#!/bin/bash
# Double-click to install (or update) Renewal Desk Texter on this Mac.
# It builds a small background app from texter.js, keeps it running with launchd, and opens the two things macOS asks once:
# sign in to Renewal Desk, and Full Disk Access (so it can read replies in Messages).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.rhinoinsurance.renewaldesk.texter"
APP="$HOME/Applications/Renewal Desk Texter.app"
SUP="$HOME/Library/Application Support/Renewal Desk Texter"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PB=/usr/libexec/PlistBuddy

echo "Installing Renewal Desk Texter..."
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
mkdir -p "$HOME/Applications" "$SUP" "$HOME/Library/LaunchAgents"
chmod 700 "$SUP"

rm -rf "$APP"
osacompile -l JavaScript -s -o "$APP" "$HERE/texter.js"
INFO="$APP/Contents/Info.plist"
$PB -c "Delete :LSUIElement" "$INFO" 2>/dev/null || true
$PB -c "Add :LSUIElement bool true" "$INFO"
$PB -c "Set :CFBundleIdentifier $LABEL" "$INFO" 2>/dev/null || $PB -c "Add :CFBundleIdentifier string $LABEL" "$INFO"
$PB -c "Delete :NSAppleEventsUsageDescription" "$INFO" 2>/dev/null || true
$PB -c "Add :NSAppleEventsUsageDescription string Sends the Qtax texts you approve through Messages." "$INFO"
codesign --force --deep --sign - "$APP"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$APP/Contents/MacOS/applet</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>
EOF
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo
echo "Installed. A Renewal Desk sign-in box will pop up: sign in once."
echo
echo "Last step: in the System Settings window that opens, turn ON 'Renewal Desk Texter' under Full Disk Access."
echo "If it isn't in the list, drag it in from the Finder window that opens next to it."
sleep 2
open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
open -R "$APP"
