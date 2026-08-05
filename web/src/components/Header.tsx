function BrandMark() {
  // Logo comes off the server: an operator file from <data-dir>/brand/ when
  // present, else the built-in Anara mark. Loaded via <img> (not inline SVG) so
  // swapping the file rebrands without a web rebuild. The same file renders
  // on both themes, so supply a theme-agnostic SVG (docs/configuration.md).
  return <img className="brand-logo" src="/brand/logo.svg" alt="" aria-hidden="true" />;
}

export function Header({
  online,
  lastUpdatedAt,
  teamName,
}: {
  online: boolean;
  lastUpdatedAt: number | null;
  teamName: string | null;
}) {
  return (
    <header>
      <span className="brand">
        <BrandMark />
        tokenleader
      </span>
      {teamName && <span className="team">{teamName}</span>}
      <span className="spacer" />
      <span className="poll">
        <span className={online ? "dot" : "dot bad"} />
        {online ? "online" : "server error"}
        {lastUpdatedAt ? ` · updated ${new Date(lastUpdatedAt).toLocaleTimeString()}` : ""}
      </span>
    </header>
  );
}
