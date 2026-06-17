import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { loadAdminToken, purgeLegacyTokenStorage, storeAdminToken } from "../adminToken";
import { fetchFleet } from "../api";
import { CategoryManager } from "../components/CategoryManager";
import { DangerZone } from "../components/DangerZone";
import { FleetPanel } from "../components/FleetPanel";
import { PeopleAssignment } from "../components/PeopleAssignment";

export const Route = createFileRoute("/admin")({
  component: AdminPage,
});

const FLEET_POLL_MS = 60_000;

/**
 * Admin maintenance panel. The token gate here is pure UX — the server
 * enforces the bearer on POST /admin/clear regardless; /stats/fleet is
 * dashboard-public data. sessionStorage keeps the token tab-scoped.
 */
function AdminPage() {
  const [token, setToken] = useState<string>(() => loadAdminToken());
  useEffect(() => {
    purgeLegacyTokenStorage();
    document.title = "admin — tokenleader";
  }, []);

  const unlocked = token.trim().length > 0;

  // The fleet panel rides along on the admin page (the "who is on what
  // build" view pairs with reset-user), on the same slow cadence as the
  // dashboard's copy.
  const fleet = useQuery({
    queryKey: ["stats", "fleet"],
    queryFn: fetchFleet,
    refetchInterval: FLEET_POLL_MS,
    enabled: unlocked,
  });

  const saveToken = (t: string) => {
    storeAdminToken(t);
    setToken(t);
  };

  return (
    <>
      <header>
        <span className="brand">
          <Link to="/" className="brand-link">
            tokenleader
          </Link>
        </span>
        <span className="team">admin</span>
        <span className="spacer" />
        <Link to="/" className="back-link">
          ← dashboard
        </Link>
      </header>
      <main className="wrap admin-wrap">
        <h1 className="sr-only">Admin maintenance</h1>
        <section aria-label="Admin token">
          <div className="card token-card">
            <label htmlFor="admin-token">Admin bearer (TOKENLEADER_ADMIN_TOKEN)</label>
            <input
              id="admin-token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="paste server admin token"
              value={token}
              onChange={(e) => saveToken(e.target.value)}
            />
            <p className="field-hint">
              Held in sessionStorage only — it dies with this tab. The server verifies it on every
              action.
            </p>
            {unlocked && (
              <button type="button" className="forget-btn" onClick={() => saveToken("")}>
                Forget token
              </button>
            )}
          </div>
        </section>
        {unlocked ? (
          <>
            <DangerZone token={token.trim()} />
            <CategoryManager token={token.trim()} />
            <PeopleAssignment token={token.trim()} />
            <FleetPanel data={fleet.data} />
            {fleet.data && fleet.data.fleet.length === 0 && (
              <p className="muted-2 empty-fleet">No daemons claimed yet.</p>
            )}
          </>
        ) : (
          <p className="muted-2 locked-note">
            Paste the admin token to unlock maintenance actions and the fleet panel.
          </p>
        )}
      </main>
    </>
  );
}
