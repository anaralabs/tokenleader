// The Linux counterpart of the LaunchAgent plist's EnvironmentVariables dict.
//
// On macOS the plist is not merely a service definition — the CLI and the
// watchdog both read it as the daemon's CONFIG DATABASE (handle, endpoint,
// join/link codes). systemd units are not a config store: a system unit lives
// under /etc where an unprivileged CLI can't reliably read it, and a user unit
// lives somewhere else again. So Linux gets one file, referenced by the unit
// via `EnvironmentFile=` and read directly by the CLI:
//
//     <stateDir>/daemon.env
//
// It sits in the state dir on purpose — the daemon, the CLI and the installer
// already agree on that path, so identity and the TOFU secret share a fate.
//
// Format is the intersection of `systemd.exec`'s EnvironmentFile and a plain
// KEY=VALUE dotenv: one `KEY=VALUE` per line, no quoting, no interpolation,
// `#` comments. No escaping layer exists, so nothing that would need one may
// be written: the INSTALLER is the only writer and it refuses a join/company/
// link value carrying a quote, a control character or edge whitespace
// (reject_unsafe_env_value in src/server/install-script.ts) — systemd's
// parser would hand the daemon different bytes than the operator typed. This
// module only READS.

/** `<stateDir>/daemon.env` — the Linux config store. */
export function daemonEnvFilePath(stateDir: string): string {
  return `${stateDir.replace(/\/+$/, "")}/daemon.env`;
}

/** Parse KEY=VALUE lines. Only ALL-CAPS keys match, mirroring parsePlistEnv. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // Tolerate a quoted value even though we never write one.
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
