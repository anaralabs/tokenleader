import type { FleetDevice, FleetEntry, FleetStats } from "../api";
import { relTime } from "../format";

function deviceSummary(d: FleetDevice): string {
  const name = d.label ?? "unnamed";
  const seen = d.lastSeen ? relTime(d.lastSeen) : "never";
  return `${name}: ${d.version ?? "unknown"} (${seen})`;
}

// Health answers "are we receiving this teammate's usage?", NOT "are they on
// the newest daemon". A daemon only posts when there's new activity, so recency
// of the last post is the liveness signal — and an OLD daemon posts usage
// exactly as well as a new one (the server never gates ingest on version), so
// version is deliberately kept out of the health verdict.
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
function isActive(f: FleetEntry): boolean {
  return typeof f.lastSeen === "number" && Date.now() - f.lastSeen < ACTIVE_WINDOW_MS;
}

function badge(f: FleetEntry): { cls: string; text: string } {
  if (!f.reporting) return { cls: "fleet-unknown", text: "no daemon" };
  return isActive(f) ? { cls: "fleet-ok", text: "active" } : { cls: "fleet-neutral", text: "idle" };
}

// Version freshness is informational — shown beside the version, never a health
// alarm. `isLatest === false` is a behind-but-fine daemon; `null` means there's
// no published version to compare against (boot window / no GH token).
function versionBehind(f: FleetEntry): boolean {
  return f.reporting && f.isLatest === false;
}

function summarize(data: FleetStats): string {
  const active = data.fleet.filter(isActive).length;
  const idle = data.fleet.filter((f) => f.reporting && !isActive(f)).length;
  const noDaemon = data.fleet.filter((f) => !f.reporting).length;
  const parts = [`${active} active`];
  if (idle) parts.push(`${idle} idle`);
  if (noDaemon) parts.push(`${noDaemon} no daemon`);
  return parts.join(" · ");
}

// Hidden until the first /stats/fleet response with at least one teammate —
// the panel is meaningless on an empty fleet.
export function FleetPanel({
  data,
  focusUser,
}: {
  data: FleetStats | undefined;
  /** Focus mode: dim every other teammate's row (no data change). */
  focusUser?: string;
}) {
  if (!data || data.fleet.length === 0) return null;

  return (
    <section aria-label="Daemon fleet">
      <div className="card">
        <div className="card-scroll">
          <table>
            <caption className="sr-only">Daemon fleet — posting health per teammate</caption>
            <thead>
              <tr>
                <th>
                  Daemon fleet <span className="fleet-summary">— {summarize(data)}</span>
                </th>
                <th>Version</th>
                <th>Arch</th>
                <th>Status</th>
                <th>Last check-in</th>
              </tr>
            </thead>
            <tbody>
              {data.fleet.map((f) => {
                const b = badge(f);
                const dimmed = focusUser !== undefined && f.user !== focusUser;
                const devices = f.devices ?? [];
                return (
                  <tr key={f.user} className={dimmed ? "is-dimmed" : ""}>
                    <td>
                      {f.user}
                      {devices.length > 1 && (
                        <span
                          className="fleet-devcount"
                          title={devices.map(deviceSummary).join("\n")}
                        >
                          ×{devices.length}
                        </span>
                      )}
                    </td>
                    <td className="fleet-version">
                      {f.reporting ? (
                        <>
                          {f.version}
                          {versionBehind(f) && <span className="muted-2"> · update pending</span>}
                        </>
                      ) : (
                        <span className="muted-2">unknown</span>
                      )}
                    </td>
                    <td className="muted">{f.arch || "—"}</td>
                    <td>
                      <span className={`fleet-badge ${b.cls}`}>{b.text}</span>
                    </td>
                    <td className="muted">{f.lastSeen ? relTime(f.lastSeen) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
