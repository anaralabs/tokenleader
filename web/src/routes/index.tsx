import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { useEffect, useMemo } from "react";
import { fetchAdminStats, fetchFleet, fetchUserStats } from "../api";
import { ContributionGrid } from "../components/ContributionGrid";
import { ErrorBanner } from "../components/ErrorBanner";
import { FleetPanel } from "../components/FleetPanel";
import { FooterMeta } from "../components/FooterMeta";
import { Header } from "../components/Header";
import { Hero } from "../components/Hero";
import { InstallFooter } from "../components/InstallSnippet";
import { CompanyFavicon, LeaderboardTable } from "../components/LeaderboardTable";
import { ModelsTable } from "../components/ModelsTable";
import { RangePills } from "../components/RangePills";
import { StatsStrip } from "../components/StatsStrip";
import { ThemeHint } from "../components/ThemeToggle";
import { UninstalledList } from "../components/UninstalledList";
import {
  parseDashboardSearch,
  toggleCategory,
  toggleCompany,
  toggleFocus,
  userModelsToRows,
} from "../focus";
import { defaultRange, persistRange } from "../range";

export const Route = createFileRoute("/")({
  // Focus mode + range pills live in the URL (?user=alice&range=2026-06):
  // shareable, back-button-able, survives refresh. parseDashboardSearch
  // drops malformed values so a hand-edited URL can't wedge the page.
  validateSearch: parseDashboardSearch,
  component: Dashboard,
});

const ADMIN_POLL_MS = 5_000;
const FLEET_POLL_MS = 60_000;

function Dashboard() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });

  const focusUser = search.user;
  const activeCompany = search.company;
  const activeCategory = search.categoryId;
  // URL range wins; otherwise the localStorage-persisted default.
  const fallbackRange = useMemo(() => defaultRange(), []);
  const range = search.range ?? fallbackRange;

  // ?company= / ?category= scope the admin payload server-side (leaderboard,
  // models, messages, totals) — the strip/tables below render it untouched.
  // Company and category are mutually exclusive (the UI only ever sets one).
  const admin = useQuery({
    queryKey: ["stats", "admin", range, activeCompany ?? "", activeCategory ?? ""],
    queryFn: () => fetchAdminStats(range, activeCompany, activeCategory),
    refetchInterval: ADMIN_POLL_MS,
    // Range switch keeps the previous rows on screen (dimmed) instead of
    // collapsing back to skeletons.
    placeholderData: keepPreviousData,
  });

  // Focus mode: per-user totals + byModel from GET /stats?user=. The key
  // includes user AND range so caches are per-(user, range); enabled only
  // while focused, so the team view never pays for it.
  const focusStats = useQuery({
    queryKey: ["stats", "user", focusUser ?? "", range],
    queryFn: () => fetchUserStats(focusUser!, range),
    enabled: focusUser !== undefined,
    refetchInterval: ADMIN_POLL_MS,
    // Switching focus between users keeps the previous user's numbers
    // dimmed (isPlaceholderData) instead of blanking the strip + models.
    placeholderData: keepPreviousData,
  });

  const fleet = useQuery({
    queryKey: ["stats", "fleet"],
    queryFn: fetchFleet,
    refetchInterval: FLEET_POLL_MS,
  });

  const teamName = admin.data?.server.teamName ?? null;
  useEffect(() => {
    document.title = teamName ? `${teamName} — tokenleader` : "tokenleader";
  }, [teamName]);

  const pickRange = (r: string) => {
    persistRange(r);
    // replace: range is a view preference — keep Back for focus toggles.
    void navigate({
      search: (prev) => ({ ...prev, range: r }),
      replace: true,
    });
  };

  const setFocus = (user: string | undefined) => {
    void navigate({ search: (prev) => ({ ...prev, user }) });
  };
  const onToggleUser = (user: string) => setFocus(toggleFocus(focusUser, user));
  const clearFocus = () => setFocus(undefined);

  // Company filter (?company=): clicking the active chip clears it, any
  // other chip moves it. Push (no replace) so Back undoes a filter, same
  // as focus toggles.
  const onToggleCompany = (company: string) => {
    void navigate({
      search: (prev) => ({ ...prev, company: toggleCompany(activeCompany, company) }),
    });
  };

  // Category filter (?category=): same toggle semantics as company, over ids.
  const onToggleCategory = (categoryId: number) => {
    void navigate({
      search: (prev) => ({ ...prev, categoryId: toggleCategory(activeCategory, categoryId) }),
    });
  };

  // Pills read the server's always-global companies list (never narrowed
  // by &company=) so the row survives an active filter; the scoped
  // leaderboard would otherwise collapse it to one chip.
  const companies = admin.data?.companies ?? [];
  // Categories are also always-global; gate filter pills on assignedCount >= 1
  // so a defined-but-unassigned category can't empty the board with no
  // explanation (the company precedent never hits this — its chips are
  // data-derived). The full list still drives the chip-render guard below.
  const categories = admin.data?.categories ?? [];
  const pillCategories = categories.filter((cat) => cat.assignedCount >= 1);

  // Dangling-filter self-heal: if ?category= points at an id the server no
  // longer returns (deleted/unknown), the board would be empty with no
  // clearable pill — drop the param. Done during render (no useEffect, per the
  // no-useEffect convention) and only once the list has actually loaded, so an
  // in-flight first fetch doesn't wrongly clear a valid filter.
  if (
    activeCategory !== undefined &&
    admin.data !== undefined &&
    !categories.some((cat) => cat.id === activeCategory)
  ) {
    void navigate({
      search: (prev) => ({ ...prev, categoryId: undefined }),
      replace: true,
    });
  }

  // Escape clears the focus (alongside the explicit ✕ chip and re-clicking
  // the selected row). Skips text inputs so it never hijacks typing.
  useEffect(() => {
    if (focusUser === undefined) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable)
      ) {
        return;
      }
      clearFocus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focusUser]);

  const retryAll = () => {
    void admin.refetch();
    void fleet.refetch();
    if (focusUser !== undefined) void focusStats.refetch();
  };

  // First-run hero: eventsCount is lifetime, so an empty range pick never
  // false-triggers it. Undefined (first load in flight) renders skeletons.
  const serverEmpty = admin.data?.server.eventsCount === 0;
  const joinRequired = admin.data?.server.joinRequired === true;

  // Focused models table: the user's byModel from the same /stats payload
  // (undefined while the first per-user fetch is in flight → ghost rows).
  const focusModelRows = focusStats.data ? userModelsToRows(focusStats.data) : undefined;

  return (
    <>
      <Header
        online={!admin.isError}
        lastUpdatedAt={admin.dataUpdatedAt || null}
        teamName={teamName}
      />
      <div className="page-controls">
        <RangePills value={range} onChange={pickRange} />
        {focusUser !== undefined && (
          <button
            type="button"
            className="focus-chip"
            onClick={clearFocus}
            aria-label={`Clear focus on ${focusUser}`}
            title="Clear focus (Esc)"
          >
            <span aria-hidden="true">✕</span> {focusUser}
          </button>
        )}
        <ThemeHint />
      </div>
      <main className="wrap" data-range-loading={admin.isPlaceholderData || undefined}>
        {admin.isError && <ErrorBanner onRetry={retryAll} />}
        {serverEmpty ? (
          <Hero joinRequired={joinRequired} />
        ) : (
          <>
            {/* The hero owns the visible <h1> in the empty state; the data
                view keeps the page chrome-less, so its h1 is SR-only. */}
            <h1 className="sr-only">
              {teamName ? `${teamName} — tokenleader` : "tokenleader"} dashboard
            </h1>
            <StatsStrip
              data={admin.data}
              focus={
                focusUser !== undefined
                  ? {
                      user: focusUser,
                      stats: focusStats.data,
                      isPlaceholder: focusStats.isPlaceholderData,
                    }
                  : undefined
              }
            />
            <section aria-label="Activity calendar">
              {/* Focus wins over the company filter (existing behavior). */}
              <ContributionGrid
                focusUser={focusUser}
                company={focusUser !== undefined ? undefined : activeCompany}
              />
            </section>
            {companies.length >= 1 && (
              <div className="company-row" role="group" aria-label="Filter by company">
                {companies.map((company) => {
                  const on = activeCompany === company;
                  return (
                    <button
                      key={company}
                      type="button"
                      className={`company-pill${on ? " on" : ""}`}
                      aria-pressed={on}
                      title={on ? "Clear company filter" : `Show only ${company}`}
                      onClick={() => onToggleCompany(company)}
                    >
                      <CompanyFavicon domain={company} />
                      {company}
                    </button>
                  );
                })}
              </div>
            )}
            {pillCategories.length >= 1 && (
              <div className="category-row" role="group" aria-label="Filter by category">
                {pillCategories.map((cat) => {
                  const on = activeCategory === cat.id;
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      className={`category-pill${on ? " on" : ""}`}
                      style={{ "--cat": cat.color ?? "var(--text-secondary)" } as CSSProperties}
                      aria-pressed={on}
                      title={on ? "Clear category filter" : `Show only ${cat.name}`}
                      onClick={() => onToggleCategory(cat.id)}
                    >
                      <span className="dot" aria-hidden="true" />
                      {cat.name}
                    </button>
                  );
                })}
              </div>
            )}
            <section aria-label="Leaderboard">
              {/* Rows arrive already company-scoped from /stats/admin. */}
              <LeaderboardTable
                rows={admin.data?.leaderboard}
                failed={admin.isError && !admin.data}
                onRetry={retryAll}
                focusUser={focusUser}
                onToggleUser={onToggleUser}
              />
            </section>
            <section aria-label="Models">
              <ModelsTable
                rows={focusUser !== undefined ? focusModelRows : admin.data?.byModel}
                failed={
                  focusUser !== undefined
                    ? focusStats.isError && !focusStats.data
                    : admin.isError && !admin.data
                }
                onRetry={retryAll}
                dim={focusUser !== undefined && focusStats.isPlaceholderData}
              />
            </section>
            <FleetPanel data={fleet.data} focusUser={focusUser} />
            <UninstalledList rows={admin.data?.uninstalled} focusUser={focusUser} />
            <InstallFooter joinRequired={joinRequired} />
          </>
        )}
        <FooterMeta server={admin.data?.server} />
      </main>
    </>
  );
}
