import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AdminClearError, assignUserCategory, fetchCategories, fetchClaimedUsers } from "../api";

type Status =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "ok"; text: string }
  | { kind: "bad"; text: string };

function describeError(e: unknown): string {
  if (e instanceof AdminClearError) {
    const hint = e.status === 401 || e.status === 403 ? " — check the admin token" : "";
    return `HTTP ${e.status} — ${e.message}${hint}`;
  }
  return `network error: ${String(e)}`;
}

/**
 * Per-user category assignment table. One <select> per claimed user, its
 * defaultValue seeded from the user's current categoryId (this is why
 * GET /admin/users must carry category_id — otherwise every dropdown wrongly
 * reads "unassigned" while assignments are live on the board). On change it
 * POSTs the assignment, then invalidates ["stats"] (dashboard chips) and
 * ["admin", "users"] (this roster). The roster includes uninstalled users;
 * assigning one is harmless (they won't appear in the active-range board).
 */
export function PeopleAssignment({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  const users = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => fetchClaimedUsers(token),
    enabled: token.length > 0,
  });
  const categories = useQuery({
    queryKey: ["admin", "categories"],
    queryFn: () => fetchCategories(token),
    enabled: token.length > 0,
  });

  const onAssign = async (user: string, categoryId: number | null) => {
    setStatus({ kind: "working" });
    try {
      await assignUserCategory(token, user, categoryId);
      setStatus({ kind: "ok", text: `Updated '${user}'.` });
      void queryClient.invalidateQueries({ queryKey: ["stats"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "categories"] });
    } catch (e) {
      setStatus({ kind: "bad", text: describeError(e) });
    }
  };

  const rows = users.data ?? [];
  const cats = categories.data ?? [];

  return (
    <section aria-label="Assign categories">
      <div className="card people-assign">
        <h2 className="card-title">Assign categories</h2>
        {users.isError ? (
          <p className="danger-status bad" role="status">
            {describeError(users.error)}
          </p>
        ) : (
          <table className="people-assign-table">
            <caption className="sr-only">Per-user category assignment</caption>
            <thead>
              <tr>
                <th>User</th>
                <th>Category</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.username}>
                  <td>{u.username}</td>
                  <td>
                    <select
                      aria-label={`Category for ${u.username}`}
                      defaultValue={u.categoryId === null ? "" : String(u.categoryId)}
                      onChange={(e) =>
                        void onAssign(
                          u.username,
                          e.target.value === "" ? null : Number(e.target.value),
                        )
                      }
                    >
                      <option value="">— unassigned —</option>
                      {cats.map((cat) => (
                        <option key={cat.id} value={String(cat.id)}>
                          {cat.name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={2} className="muted-2">
                    No claimed users yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
        <p
          className={`danger-status ${status.kind === "ok" ? "ok" : status.kind === "bad" ? "bad" : ""}`}
          role="status"
          aria-live="polite"
        >
          {status.kind === "ok" || status.kind === "bad"
            ? status.text
            : status.kind === "working"
              ? "Working…"
              : "No action taken."}
        </p>
      </div>
    </section>
  );
}
