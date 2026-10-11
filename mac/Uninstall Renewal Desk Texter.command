#!/bin/bash
# Double-click to remove Renewal Desk Texter from this Mac (for example after moving it to another Mac),
# so two Macs never send the same text. Your texts, contacts and the Renewal Desk data are not touched.
LABEL="com.rhinoinsurance.renewaldesk.texter"
APP="$HOME/Applications/Renewal Desk Texter.app"
echo "Removing Renewal Desk Texter from this Mac..."
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" 2>/dev/null || true
osascript -e 'tell application "System Events" to delete (every login item whose name is "Renewal Desk Texter")' >/dev/null 2>&1 || true
osascript -e "tell application id \"$LABEL\" to quit" >/dev/null 2>&1 || true
pkill -f "Renewal Desk Texter.app" 2>/dev/null || true
rm -rf "$APP" "$HOME/Library/Application Support/Renewal Desk Texter"
tccutil reset SystemPolicyAllFiles "$LABEL" >/dev/null 2>&1 || true
echo
echo "Done. Renewal Desk Texter is off this Mac."
