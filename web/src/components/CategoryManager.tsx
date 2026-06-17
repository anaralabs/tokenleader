import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  AdminClearError,
  type Category,
  createCategory,
  deleteCategoryApi,
  fetchCategories,
  updateCategory,
} from "../api";

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
 * Admin CRUD for the dashboard categories (create / rename / recolor /
 * delete). Mutations are imperative (no useMutation), tracking a local Status
 * union like DangerZone; on success they invalidate BOTH ["admin",
 * "categories"] (this list + PeopleAssignment) and ["stats"] (the dashboard's
 * chips + filter pills). Deleting a category unassigns everyone in it
 * (server-side, in one transaction), so the confirm copy warns about that.
 */
export function CategoryManager({ token }: { token: string }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [newName, setNewName] = useState("");

  const categories = useQuery({
    queryKey: ["admin", "categories"],
    queryFn: () => fetchCategories(token),
    enabled: token.length > 0,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "categories"] });
    void queryClient.invalidateQueries({ queryKey: ["stats"] });
  };

  const onCreate = async () => {
    const name = newName.trim();
    if (name.length === 0) return;
    setStatus({ kind: "working" });
    try {
      await createCategory(token, name);
      setStatus({ kind: "ok", text: `Created '${name}'.` });
      setNewName("");
      refresh();
    } catch (e) {
      setStatus({ kind: "bad", text: describeError(e) });
    }
  };

  const onSave = async (cat: Category, name: string) => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    setStatus({ kind: "working" });
    try {
      await updateCategory(token, cat.id, trimmed);
      setStatus({ kind: "ok", text: `Saved '${trimmed}'.` });
      refresh();
    } catch (e) {
      setStatus({ kind: "bad", text: describeError(e) });
    }
  };

  const onDelete = async (cat: Category) => {
    if (
      !window.confirm(
        `Delete category '${cat.name}'? This unassigns everyone currently in it ` +
          `(${cat.assignedCount} ${cat.assignedCount === 1 ? "user" : "users"}).`,
      )
    ) {
      return;
    }
    setStatus({ kind: "working" });
    try {
      await deleteCategoryApi(token, cat.id);
      setStatus({ kind: "ok", text: `Deleted '${cat.name}'.` });
      refresh();
    } catch (e) {
      setStatus({ kind: "bad", text: describeError(e) });
    }
  };

  const rows = categories.data ?? [];

  return (
    <section aria-label="Categories">
      <div className="card category-admin">
        <h2 className="card-title">Categories</h2>
        <p className="field-hint">
          Admin-defined groups for the leaderboard. Names and per-user assignments are visible to
          anyone who can load the dashboard — don&apos;t use sensitive labels.
        </p>
        {categories.isError ? (
          <p className="danger-status bad" role="status">
            {describeError(categories.error)}
          </p>
        ) : (
          <ul className="category-admin-list">
            {rows.map((cat) => (
              <CategoryRowEditor
                key={cat.id}
                cat={cat}
                onSave={(name) => void onSave(cat, name)}
                onDelete={() => void onDelete(cat)}
              />
            ))}
            {rows.length === 0 && <li className="muted-2">No categories yet — add one below.</li>}
          </ul>
        )}
        <div className="category-admin-add">
          <input
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder="new category name"
            aria-label="New category name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button
            type="button"
            onClick={() => void onCreate()}
            disabled={newName.trim().length === 0}
          >
            Add category
          </button>
        </div>
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

function CategoryRowEditor({
  cat,
  onSave,
  onDelete,
}: {
  cat: Category;
  onSave: (name: string) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(cat.name);
  const dirty = name.trim() !== cat.name;

  return (
    <li className="category-admin-row">
      <input
        type="text"
        autoComplete="off"
        spellCheck={false}
        aria-label={`Name for ${cat.name}`}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <span className="muted-2 category-admin-count">
        {cat.assignedCount} {cat.assignedCount === 1 ? "user" : "users"}
      </span>
      <button type="button" onClick={() => onSave(name)} disabled={!dirty}>
        Save
      </button>
      <button type="button" className="category-admin-delete" onClick={onDelete}>
        Delete
      </button>
    </li>
  );
}
