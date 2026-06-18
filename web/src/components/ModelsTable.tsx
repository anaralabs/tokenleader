import type { ReactNode } from "react";
import type { ModelRow } from "../api";
import { fmtCompact, fmtInt, fmtUsd } from "../format";

const COLS = 7;

export function ModelsTable({
  rows,
  failed,
  onRetry,
  dim,
}: {
  rows: ModelRow[] | undefined;
  failed: boolean;
  onRetry: () => void;
  /** Focus switch in flight: previous rows stay visible but dimmed. */
  dim?: boolean;
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
    body = rows.map((m) => (
      <tr key={m.model}>
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
    ));
  }

  return (
    <div className="card dimmable" data-section-loading={dim || undefined}>
      <div className="card-scroll">
      <table>
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
