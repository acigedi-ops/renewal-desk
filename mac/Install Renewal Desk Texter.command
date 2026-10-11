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

PLIST_XML="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$APP/Contents/MacOS/applet</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>ProcessType</key><string>Interactive</string>
</dict></plist>"
# Keep it running with launchd. On some Macs ~/Library/LaunchAgents belongs to another account and can't be written;
# then start it as a Login Item instead (it still starts at login and stays open).
if { printf '%s\n' "$PLIST_XML" > "$PLIST"; } 2>/dev/null && launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
  echo "Set to start automatically (launchd)."
else
  osascript -e 'tell application "System Events" to delete (every login item whose name is "Renewal Desk Texter")' >/dev/null 2>&1 || true
  osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$APP\", hidden:true}" >/dev/null \
    && echo "Set to start automatically (Login Items)." || echo "Couldn't add it to Login Items; it runs now but won't start by itself after a restart."
  open "$APP"
fi

echo
echo "Installed. A Renewal Desk sign-in box will pop up: sign in once."
echo
echo "Last step: in the System Settings window that opens, turn ON 'Renewal Desk Texter' under Full Disk Access."
echo "If it isn't in the list, drag it in from the Finder window that opens next to it."
sleep 2
open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"
open -R "$APP"
