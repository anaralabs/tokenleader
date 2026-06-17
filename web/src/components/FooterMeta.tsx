import { Link } from "@tanstack/react-router";
import type { ServerInfo } from "../api";
import { fmtBytes, fmtUptime } from "../format";

/** Slim server-meta strip at the page bottom: release version, uptime and
 *  DB size from the /stats/admin server block, plus the route into /admin. */
export function FooterMeta({ server }: { server: ServerInfo | undefined }) {
  if (!server) return null;
  // The version may or may not already carry a "v" (TOKENLEADER_SERVER_VERSION
  // is set as "v0.5.0") — normalize to exactly one so it never reads "vv0.5.0".
  const version = server.version ? `v${server.version.replace(/^v+/, "")}` : "";
  return (
    <footer className="meta-strip">
      <span className="mono">tokenleader{version ? ` ${version}` : ""}</span>
      <span aria-hidden="true">·</span>
      <span>up {fmtUptime(server.uptimeMs)}</span>
      <span aria-hidden="true">·</span>
      <span>db {fmtBytes(server.dbSizeBytes)}</span>
      <span className="spacer" />
      <Link to="/admin" className="admin-link">
        Admin
      </Link>
    </footer>
  );
}
