#!/usr/bin/env bash
# Sourceable helpers that render LaunchAgent plists for the tokenleader
# daemon and server. Both functions write XML to stdout; callers redirect.
set -euo pipefail

# render_daemon_plist <user> <endpoint> <home>
#   user     - leaderboard handle (already validated [a-z0-9_-]{1,32})
#   endpoint - HTTPS URL of the central server
#   home     - absolute path to $HOME (so logs/program path resolve)
#
# The daemon generates its own per-user TOFU secret on first run under
# $TOKENLEADER_HOME (default $HOME/.local/share/anara-leaderboard/secret), so no
# bearer token needs to be templated into the plist.
render_daemon_plist() {
  local user="$1"
  local endpoint="$2"
  local home="$3"

  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTD/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>sh.anara.leaderboard</string>
    <key>Program</key>
    <string>${home}/.local/bin/anara-leaderboard</string>
    <key>ProgramArguments</key>
    <array>
        <string>${home}/.local/bin/anara-leaderboard</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>TOKENLEADER_USER</key>
        <string>${user}</string>
        <key>TOKENLEADER_ENDPOINT</key>
        <string>${endpoint}</string>
        <key>TOKENLEADER_HOME</key>
        <string>${home}/.local/share/anara-leaderboard</string>
        <key>HOME</key>
        <string>${home}</string>
        <key>PATH</key>
        <string>${home}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <!-- Unconditional: respawn on ANY exit, clean or crash. A {SuccessfulExit:false}
         dict strands the daemon whenever it exits 0 (e.g. the post-update restart)
         until the next login — the v0.5.x fleet-stuck incident. -->
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${home}/Library/Logs/anara-leaderboard/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${home}/Library/Logs/anara-leaderboard/stderr.log</string>
    <key>WorkingDirectory</key>
    <string>${home}</string>
</dict>
</plist>
EOF
}

# render_server_plist <port> <db_path> <home> [public_url] [gh_token] [cursor_token] [gh_repo] [cursor_map]
#   port          - TCP port for the HTTP server (typically 8787)
#   db_path       - absolute path to the sqlite file
#   home          - absolute path to $HOME on the server host
#   public_url    - (optional) public-facing URL for the server. Currently
#                   informational only — the dashboard / docs use it.
#   gh_token      - (optional) GitHub token with read access to gh_repo.
#                   Powers the in-server BinaryMirror that pulls daemon
#                   binaries from the GH Release. The mirror needs BOTH
#                   gh_token and gh_repo; without them the server still
#                   boots, but /manifest.json and /bin/* return 503
#                   (auto-update channel is offline).
#   cursor_token  - (optional) Cursor admin API key (crsr_*). Powers the
#                   in-server CursorMirror that polls Cursor's team usage
#                   API and inserts source='cursor' rows. If unset, the
#                   server still boots, but the leaderboard won't include
#                   Cursor usage.
#   gh_repo       - (optional) owner/repo the BinaryMirror pulls from.
#   cursor_map    - (optional) email→handle JSON for the Cursor mirror.
#                   REQUIRED with cursor_token (the server fails boot on
#                   token-without-map).
#
# No bearer token is templated in: per-user TOFU secrets are claimed by
# the server on first /ingest and stored in the sqlite db.
render_server_plist() {
  local port="$1"
  local db_path="$2"
  local home="$3"
  local public_url="${4:-}"
  local gh_token="${5:-}"
  local cursor_token="${6:-}"
  local gh_repo="${7:-}"
  local cursor_map="${8:-}"

  local public_url_block=""
  if [ -n "$public_url" ]; then
    public_url_block="        <key>TOKENLEADER_SERVER_URL</key>
        <string>${public_url}</string>
"
  fi
  local gh_token_block=""
  if [ -n "$gh_token" ]; then
    gh_token_block="        <key>TOKENLEADER_GH_TOKEN</key>
        <string>${gh_token}</string>
"
  fi
  local gh_repo_block=""
  if [ -n "$gh_repo" ]; then
    gh_repo_block="        <key>TOKENLEADER_GH_REPO</key>
        <string>${gh_repo}</string>
"
  fi
  local cursor_token_block=""
  if [ -n "$cursor_token" ]; then
    cursor_token_block="        <key>TOKENLEADER_CURSOR_TOKEN</key>
        <string>${cursor_token}</string>
"
  fi
  local cursor_map_block=""
  if [ -n "$cursor_map" ]; then
    cursor_map_block="        <key>TOKENLEADER_CURSOR_USER_MAP</key>
        <string>${cursor_map}</string>
"
  fi

  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTD/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>sh.anara.leaderboard-server</string>
    <key>Program</key>
    <string>${home}/.local/bin/anara-leaderboard-server</string>
    <key>ProgramArguments</key>
    <array>
        <string>${home}/.local/bin/anara-leaderboard-server</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PORT</key>
        <string>${port}</string>
        <key>TOKENLEADER_DB</key>
        <string>${db_path}</string>
${public_url_block}${gh_repo_block}${gh_token_block}${cursor_token_block}${cursor_map_block}        <key>HOME</key>
        <string>${home}</string>
        <key>PATH</key>
        <string>${home}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <!-- Unconditional: respawn on ANY exit, clean or crash. A {SuccessfulExit:false}
         dict strands the daemon whenever it exits 0 (e.g. the post-update restart)
         until the next login — the v0.5.x fleet-stuck incident. -->
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>30</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${home}/Library/Logs/anara-leaderboard/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${home}/Library/Logs/anara-leaderboard/stderr.log</string>
    <key>WorkingDirectory</key>
    <string>${home}</string>
</dict>
</plist>
EOF
}
