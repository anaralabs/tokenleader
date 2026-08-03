import type { ReactNode } from "react";
import type { ModelRow } from "../api";
import { fmtCompact, fmtInt, fmtUsd } from "../format";

const COLS = 7;

export function ModelsTable({
  rows,
  failed,
  onRetry,
  dim,
  activeModel,
  onToggleModel,
}: {
  rows: ModelRow[] | undefined;
  failed: boolean;
  onRetry: () => void;
  /** Focus switch in flight: previous rows stay visible but dimmed. */
  dim?: boolean;
  /** Active ?model= filter: its row is selected, the rest recede. */
  activeModel?: string;
  /** Row click / Enter / Space — toggles the leaderboard's model filter. */
  onToggleModel?: (model: string) => void;
}) {
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
  } else if (!rows) {
    body = (
      <>
        {[0, 1, 2].map((r) => (
          <tr key={r} aria-hidden="true">
            {Array.from({ length: COLS }, (_, i) => (
              <td key={i} className={i > 0 ? "num" : ""}>
                <span className="ghost">000</span>
              </td>
            ))}
          </tr>
        ))}
      </>
    );
  } else if (rows.length === 0) {
    body = (
      <tr>
        <td colSpan={COLS} className="empty">
          No models in this range
        </td>
      </tr>
    );
  } else {
    body = rows.map((m) => {
      const selected = activeModel === m.model;
      const dimmed = activeModel !== undefined && !selected;
      return (
        <tr
          key={m.model}
          // Same row-as-button pattern as the leaderboard's focus toggle:
          // clicking scopes the leaderboard to this model ("who uses it
          // most"); clicking the selected row clears the filter.
          role="button"
          tabIndex={0}
          aria-pressed={selected}
          aria-label={selected ? `Clear model filter ${m.model}` : `Rank users by ${m.model} usage`}
          className={`lb-row${selected ? " is-selected" : ""}${dimmed ? " is-dimmed" : ""}`}
          onClick={() => onToggleModel?.(m.model)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggleModel?.(m.model);
            }
          }}
        >
          <td>{m.model}</td>
          <td className="num">{fmtInt(m.count)}</td>
          <td className="num">{fmtCompact(m.inputTokens)}</td>
          <td className="num">{fmtCompact(m.outputTokens)}</td>
          <td className="num col-cache">{fmtCompact(m.cacheCreationTokens)}</td>
          <td className="num col-cache">{fmtCompact(m.cacheReadTokens)}</td>
          <td className="num">
            {m.unknownPrice ? <span className="muted-2">—</span> : fmtUsd(m.costUsd)}
          </td>
        </tr>
      );
    });
  }

  return (
    <div className="card dimmable" data-section-loading={dim || undefined}>
      <div className="card-scroll">
        <table className="models-table">
          <caption className="sr-only">Token usage per model</caption>
          <thead>
            <tr>
              <th>Model</th>
              <th className="num">Messages</th>
              <th className="num">Input</th>
              <th className="num">Output</th>
              <th className="num col-cache">Cache Create</th>
              <th className="num col-cache">Cache Read</th>
              <th className="num">Cost</th>
            </tr>
          </thead>
          <tbody>{body}</tbody>
        </table>
      </div>
    </div>
  );
}
