import type { AdminStats, UserStats } from "../api";
import { fmtCompact, fmtInt, fmtUsd } from "../format";

const LABELS = [
  "Messages",
  "Total tokens",
  "Total cost",
  "Models tracked",
  "Active users",
] as const;

/** Focus-mode slice passed down by the route: which user, that user's
 *  GET /stats payload (undefined while the first fetch is in flight) and
 *  whether the visible numbers are a previous user's kept data. */
export interface StripFocus {
  user: string;
  stats: UserStats | undefined;
  isPlaceholder: boolean;
}

function Skeleton() {
  return (
    <div className="strip" aria-busy="true">
      {LABELS.map((label) => (
        <div className="stat" key={label}>
          <div className="lbl">{label}</div>
          <div className="num">
            <span className="ghost">0000</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function teamValues(data: AdminStats, activeModel?: string): string[] {
  const lb = data.leaderboard;
  const totalTokens = lb.reduce(
    (s, u) =>
      s +
      u.totalInputTokens +
      u.totalOutputTokens +
      u.totalCacheCreationTokens +
      u.totalCacheReadTokens,
    0,
  );
  // Under ?model= the leaderboard/messages are already that model's slice,
  // but byModel is deliberately left un-scoped (it stays the click surface),
  // so cost and the model count must be read off the ONE matching row —
  // otherwise the strip mixes a filtered token total with an all-model cost.
  // byModel IS company/category-scoped, so that row is the right total.
  const modelRow =
    activeModel !== undefined ? data.byModel.find((m) => m.model === activeModel) : undefined;
  const totalCost =
    activeModel !== undefined
      ? (modelRow?.costUsd ?? 0)
      : data.byModel.reduce((s, m) => s + (m.costUsd || 0), 0);
  const totalMsg = data.messages.userMessages + data.messages.assistantMessages;
  return [
    fmtCompact(totalMsg),
    fmtCompact(totalTokens),
    fmtUsd(totalCost),
    fmtInt(activeModel !== undefined ? (modelRow ? 1 : 0) : data.byModel.length),
    fmtInt(lb.length),
  ];
}

function focusValues(stats: UserStats): string[] {
  const totalTokens =
    stats.totalInputTokens +
    stats.totalOutputTokens +
    stats.totalCacheCreationTokens +
    stats.totalCacheReadTokens;
  return [
    fmtCompact(stats.userMessages + stats.assistantMessages),
    fmtCompact(totalTokens),
    fmtUsd(stats.totalCostUsd),
    fmtInt(stats.byModel.length),
    fmtInt(1),
  ];
}

export function StatsStrip({
  data,
  focus,
  activeModel,
}: {
  data: AdminStats | undefined;
  focus?: StripFocus;
  /** Active ?model= filter — scopes the cost + models-tracked tiles. */
  activeModel?: string;
}) {
  // Focused: the strip recomputes from GET /stats?user=. First fetch for a
  // user shows the skeleton (per-section loading); switching users keeps
  // the previous numbers dimmed via isPlaceholder.
  if (focus) {
    if (!focus.stats) return <Skeleton />;
    const values = focusValues(focus.stats);
    return (
      <div className="strip dimmable" data-section-loading={focus.isPlaceholder || undefined}>
        <span className="focus-note">showing: {focus.user}</span>
        {LABELS.map((label, i) => (
          <div className="stat" key={label}>
            <div className="lbl">{label}</div>
            <div className="num">{values[i]}</div>
          </div>
        ))}
      </div>
    );
  }

  if (!data) return <Skeleton />;
  const values = teamValues(data, activeModel);
  return (
    <div className="strip dimmable">
      {LABELS.map((label, i) => (
        <div className="stat" key={label}>
          <div className="lbl">{label}</div>
          <div className="num">{values[i]}</div>
        </div>
      ))}
    </div>
  );
}
