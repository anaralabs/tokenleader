import type { FleetDevice, FleetEntry, FleetStats } from "../api";
import { relTime } from "../format";

function deviceSummary(d: FleetDevice): string {
  const name = d.label ?? "unnamed";
  const seen = d.lastSeen ? relTime(d.lastSeen) : "never";
  return `${name}: ${d.version ?? "unknown"} (${seen})`;
}

// A daemon seen within its hourly update window (+ jitter slack) that isn't
// on the newest build yet is just mid-rollout, not a problem — "updating".
// Only quiet-for-longer daemons earn the orange "stale".
const UPDATE_WINDOW_MS = 90 * 60 * 1000;
function isUpdating(f: FleetEntry): boolean {
  return (
    f.reporting &&
    f.isLatest === false &&
    typeof f.lastSeen === "number" &&
    Date.now() - f.lastSeen < UPDATE_WINDOW_MS
  );
}

function badge(f: FleetEntry): { cls: string; text: string } {
  if (!f.reporting) return { cls: "fleet-unknown", text: "old daemon" };
  if (f.isLatest === true) return { cls: "fleet-ok", text: "latest" };
  if (f.isLatest === false) {
    return isUpdating(f)
      ? { cls: "fleet-neutral", text: "updating" }
      : { cls: "fleet-stale", text: "stale" };
  }
  // No published manifest to compare against (boot window / no GH token).
  return { cls: "fleet-neutral", text: "reporting" };
}

function summarize(data: FleetStats): string {
  const onLatest = data.fleet.filter((f) => f.isLatest === true).length;
  const updating = data.fleet.filter((f) => isUpdating(f)).length;
  const stale = data.fleet.filter(
    (f) => f.isLatest === false && f.reporting && !isUpdating(f),
  ).length;
  const unknown = data.fleet.filter((f) => !f.reporting).length;
  const uncomparable = data.fleet.filter((f) => f.reporting && f.isLatest === null).length;
  const parts = data.latestVersion
    ? [
        `${onLatest} on latest (${data.latestVersion})`,
        ...(updating ? [`${updating} updating`] : []),
        ...(stale ? [`${stale} stale`] : []),
      ]
    : [`${uncomparable} reporting (no published version yet)`];
  if (unknown) parts.push(`${unknown} unknown`);
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
          <caption className="sr-only">Daemon fleet — build per teammate</caption>
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
                    {f.reporting ? f.version : <span className="muted-2">unknown</span>}
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
