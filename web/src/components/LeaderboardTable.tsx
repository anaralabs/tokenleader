import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { LeaderboardRow } from "../api";
import { fmtCompact, fmtInt, fmtUsd, relTime } from "../format";

const COLS = 9;

export type SortKey =
  | "user"
  | "messages"
  | "input"
  | "output"
  | "cacheCreate"
  | "cacheRead"
  | "cost"
  | "lastActive";
export type SortDir = "asc" | "desc";

// Per-column sort value; numbers compare numerically, the user string A→Z.
const SORT_VALUE: Record<SortKey, (u: LeaderboardRow) => number | string> = {
  user: (u) => u.user.toLowerCase(),
  messages: (u) => (u.userMessages || 0) + (u.assistantMessages || 0),
  input: (u) => u.totalInputTokens,
  output: (u) => u.totalOutputTokens,
  cacheCreate: (u) => u.totalCacheCreationTokens,
  cacheRead: (u) => u.totalCacheReadTokens,
  cost: (u) => u.costUsd ?? 0,
  lastActive: (u) => u.lastEventAt,
};

// First click on a column sorts in its natural direction (biggest/most-recent
// first for numbers; A→Z for the name); clicking the active column flips it.
const DEFAULT_DIR: Record<SortKey, SortDir> = {
  user: "asc",
  messages: "desc",
  input: "desc",
  output: "desc",
  cacheCreate: "desc",
  cacheRead: "desc",
  cost: "desc",
  lastActive: "desc",
};

/** Pure, stable leaderboard sort — exported for testing. Returns a new array. */
export function sortRows(rows: LeaderboardRow[], key: SortKey, dir: SortDir): LeaderboardRow[] {
  const get = SORT_VALUE[key];
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = get(a);
    const vb = get(b);
    const cmp =
      typeof va === "string" && typeof vb === "string"
        ? va.localeCompare(vb)
        : Number(va) - Number(vb);
    // Tie-break on user so the order is stable across re-sorts/re-renders.
    return (cmp !== 0 ? cmp * sign : a.user.localeCompare(b.user)) || 0;
  });
}

function Trophy() {
  return (
    <svg className="icon trophy" viewBox="0 0 24 24" aria-label="1" role="img">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M7 2C5.89543 2 5 2.89543 5 4H4C2.89543 4 2 4.89543 2 6V7C2 9.09706 3.61375 10.8172 5.66717 10.9864C6.65237 13.0719 8.63747 14.5925 11.0039 14.9297V17H8C6.89543 17 6 17.8954 6 19V20C6 21.1046 6.89543 22 8 22H16C17.1046 22 18 21.1046 18 20V19C18 17.8954 17.1046 17 16 17H13.0039V14.9286C15.3669 14.5892 17.3487 13.0696 18.3328 10.9864C20.3862 10.8172 22 9.09706 22 7V6C22 4.89543 21.1046 4 20 4H19C19 2.89543 18.1046 2 17 2H7ZM4 6H5V8C5 8.25512 5.01365 8.50705 5.04025 8.7551C4.42032 8.41539 4 7.75678 4 7V6ZM20 7C20 7.75678 19.5797 8.41539 18.9597 8.7551C18.9864 8.50705 19 8.25512 19 8V6H20V7Z"
      />
    </svg>
  );
}

/** Company favicon via Google's s2 service — purely decorative (empty alt,
 *  aria-hidden), lazy-loaded, and removed on error so a domain with no
 *  favicon degrades to plain text. Shared by the row chip and the filter
 *  pills in routes/index.tsx. */
export function CompanyFavicon({ domain }: { domain: string }) {
  return (
    <img
      className="company-favicon"
      loading="lazy"
      src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`}
      alt=""
      aria-hidden="true"
      width={14}
      height={14}
      onError={(e) => {
        e.currentTarget.style.display = "none";
      }}
    />
  );
}

function GhostRows() {
  return (
    <>
      {[0, 1, 2].map((r) => (
        <tr key={r} aria-hidden="true">
          {Array.from({ length: COLS }, (_, i) => (
            <td key={i} className={i >= 2 && i <= 7 ? "num" : ""}>
              <span className="ghost">000</span>
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function SortableTh({
  label,
  sortKey,
  className,
  sort,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  className?: string;
  sort: { key: SortKey; dir: SortDir };
  onSort: (key: SortKey) => void;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      className={className}
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        className={`th-sort${active ? " active" : ""}`}
        onClick={() => onSort(sortKey)}
      >
        {label}
        <span className="th-arrow" aria-hidden="true">
          {active ? (sort.dir === "asc" ? "↑" : "↓") : ""}
        </span>
      </button>
    </th>
  );
}

export function LeaderboardTable({
  rows,
  failed,
  onRetry,
  focusUser,
  onToggleUser,
}: {
  rows: LeaderboardRow[] | undefined;
  failed: boolean;
  onRetry: () => void;
  /** Focused user (focus mode): their row is selected, the rest dim. */
  focusUser?: string;
  /** Row click / Enter / Space — toggles focus on that user. */
  onToggleUser?: (user: string) => void;
}) {
  // Client-side sort: rows are already fully fetched, so re-ranking is
  // instant. Default cost-desc (the canonical leaderboard order); clicking a
  // header sorts by it, clicking again flips direction. Rank (#) renumbers to
  // the active order, so the trophy follows the top of whatever you sort by.
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "cost", dir: "desc" });
  const onSort = (key: SortKey) =>
    setSort((s) =>
      s.key === key
        ? { key, dir: s.dir === "asc" ? "desc" : "asc" }
        : { key, dir: DEFAULT_DIR[key] },
    );
  const sorted = useMemo(() => (rows ? sortRows(rows, sort.key, sort.dir) : rows), [rows, sort]);

  let body: ReactNode;
  if (failed && !rows) {
    body = (
      <tr>
        <td colSpan={COLS} className="empty">
          Couldn&apos;t load —{" "}
          <button type="button" className="link" onClick={onRetry}>
            Retry
          </button>
        </td>
      </tr>
    );
  } else if (!sorted) {
    body = <GhostRows />;
  } else if (sorted.length === 0) {
    body = (
      <tr>
        <td colSpan={COLS} className="empty">
          No activity in this range — try ALL
        </td>
      </tr>
    );
  } else {
    body = sorted.map((u, n) => {
      const selected = focusUser === u.user;
      const dimmed = focusUser !== undefined && !selected;
      return (
        <tr
          key={u.user}
          // The whole row is the focus-mode toggle. role="button" +
          // Enter/Space keep it keyboard-operable; aria-pressed announces
          // the toggle state; :focus-visible draws the ring (styles.css).
          role="button"
          tabIndex={0}
          aria-pressed={selected}
          aria-label={selected ? `Clear focus on ${u.user}` : `Focus dashboard on ${u.user}`}
          className={`lb-row${selected ? " is-selected" : ""}${dimmed ? " is-dimmed" : ""}`}
          onClick={() => onToggleUser?.(u.user)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggleUser?.(u.user);
            }
          }}
        >
          <td className="rank num">{n === 0 ? <Trophy /> : n + 1}</td>
          <td className="user-cell">
            <span className="user-line">
              {u.company && (
                <span className="company-chip" title={u.company}>
                  <CompanyFavicon domain={u.company} />
                </span>
              )}
              {u.user}
              {u.categoryName && (
                <span className="category-tag">{u.categoryName.toLowerCase()}</span>
              )}
            </span>
          </td>
          <td className="num">
            {fmtInt((u.userMessages || 0) + (u.assistantMessages || 0))}
            <div className="msg-split">
              {fmtInt(u.userMessages || 0)} u / {fmtInt(u.assistantMessages || 0)} a
            </div>
          </td>
          <td className="num">{fmtCompact(u.totalInputTokens)}</td>
          <td className="num">{fmtCompact(u.totalOutputTokens)}</td>
          <td className="num col-cache">{fmtCompact(u.totalCacheCreationTokens)}</td>
          <td className="num col-cache">{fmtCompact(u.totalCacheReadTokens)}</td>
          <td className="num">{fmtUsd(u.costUsd)}</td>
          <td className="muted">{relTime(u.lastEventAt)}</td>
        </tr>
      );
    });
  }

  return (
    <div className="card dimmable">
      <table className="lb-table">
        <caption className="sr-only">Leaderboard — token usage per user</caption>
        <thead>
          <tr>
            <th className="rank-col">#</th>
            <SortableTh label="User" sortKey="user" sort={sort} onSort={onSort} />
            <SortableTh
              label="Messages"
              sortKey="messages"
              className="num"
              sort={sort}
              onSort={onSort}
            />
            <SortableTh label="Input" sortKey="input" className="num" sort={sort} onSort={onSort} />
            <SortableTh
              label="Output"
              sortKey="output"
              className="num"
              sort={sort}
              onSort={onSort}
            />
            <SortableTh
              label="Cache Create"
              sortKey="cacheCreate"
              className="num col-cache"
              sort={sort}
              onSort={onSort}
            />
            <SortableTh
              label="Cache Read"
              sortKey="cacheRead"
              className="num col-cache"
              sort={sort}
              onSort={onSort}
            />
            <SortableTh label="Cost" sortKey="cost" className="num" sort={sort} onSort={onSort} />
            <SortableTh label="Last active" sortKey="lastActive" sort={sort} onSort={onSort} />
          </tr>
        </thead>
        <tbody>{body}</tbody>
      </table>
    </div>
  );
}
