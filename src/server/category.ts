/**
 * Category-name + color validation for admin-defined groups (Engineering,
 * Growth, …). A category name is a human DISPLAY LABEL, not a domain — so,
 * unlike normalizeCompany, we trim but do NOT lowercase (display casing is
 * preserved; the categories.name UNIQUE index is COLLATE NOCASE, so
 * "Growth"/"growth" still collide). The charset is intentionally WIDER than
 * HANDLE_SAFE_RE (it adds A-Z and space); this is safe ONLY because a category
 * name is never interpolated into a shell/install command — it flows only into
 * the /stats/admin JSON body and React text nodes (which escape). Keep it so:
 * never concatenate a category name into an HTML template string or a
 * curl/install snippet.
 */

/** Max category name length AFTER normalization (matches the username cap). */
export const MAX_CATEGORY_NAME_LENGTH = 64;

/** Letters / digits / space / `._-`. No lowercasing, no domain shape. */
const CATEGORY_NAME_RE = /^[A-Za-z0-9 ._-]+$/;

/** Six-digit hex color, e.g. "#6E56CF". */
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Normalize a raw category name. Trims, then collapses internal whitespace
 * runs so "A  B" and "A B" are one label and can't sneak past the (NOCASE)
 * UNIQUE index as visually-identical rows. Returns null for empty, too-long
 * (> 64), or out-of-charset input — callers turn null into a 400.
 */
export function normalizeCategoryName(raw: string): string | null {
  const s = raw.trim().replace(/\s+/g, " ");
  if (s.length === 0 || s.length > MAX_CATEGORY_NAME_LENGTH) return null;
  if (!CATEGORY_NAME_RE.test(s)) return null;
  return s;
}

/**
 * Normalize a raw color. Returns the canonical (lowercased) "#rrggbb"; null
 * to store NULL (absent/empty → the UI's default uncolored chip); or the
 * sentinel `false` for a present-but-malformed value (caller turns it into a
 * 400 — distinct from the null "store no color" case).
 */
export function normalizeColor(raw: unknown): string | null | false {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !COLOR_RE.test(raw)) return false;
  return raw.toLowerCase();
}
