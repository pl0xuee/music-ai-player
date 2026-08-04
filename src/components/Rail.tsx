interface Props {
  onAddLocal: () => void;
  onImport: () => void;
  onGenerate: () => void;
  scanning: boolean;
  downloading: number;
  generating: boolean;
  /** Tracks left in the shuffle bag, and how many it holds when full. */
  bagRemaining: number;
  bagSize: number;
  onSettings: () => void;
}

/**
 * The left rail: the three ways the library grows, and how much of it is left
 * to hear.
 *
 * All three sources land in the same table and play through the same decks, so
 * they sit together rather than being scattered through the interface. Each
 * shows a dot while its work is running, because all three keep going with
 * their drawer shut and the window in the tray.
 */
export function Rail(props: Props) {
  const {
    onAddLocal,
    onImport,
    onGenerate,
    scanning,
    downloading,
    generating,
    bagRemaining,
    bagSize,
    onSettings,
  } = props;

  return (
    <nav className="rail" aria-label="Sources">
      <div className="mark" aria-hidden="true">
        M
      </div>

      <button
        type="button"
        className={scanning ? "rail-btn is-live" : "rail-btn"}
        onClick={onAddLocal}
        title="Add music already on this machine"
      >
        {scanning && <span className="rail-dot" aria-hidden="true" />}
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7.5A1.5 1.5 0 0 1 17.5 19h-13A1.5 1.5 0 0 1 3 17.5Z" />
          <path d="M14 11v4.2" />
          <circle cx="12.4" cy="15.6" r="1.5" />
        </svg>
        Files
      </button>

      <button
        type="button"
        className={downloading > 0 ? "rail-btn is-live" : "rail-btn"}
        onClick={onImport}
        title="Paste YouTube links"
      >
        {downloading > 0 && <span className="rail-dot" aria-hidden="true" />}
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4v11" />
          <path d="M8 11.5 12 15.5 16 11.5" />
          <path d="M5 19h14" />
        </svg>
        {downloading > 0 ? `${downloading} left` : "Import"}
      </button>

      <button
        type="button"
        className={generating ? "rail-btn is-live" : "rail-btn"}
        onClick={onGenerate}
        title="Render new tracks on the GPU"
      >
        {generating && <span className="rail-dot" aria-hidden="true" />}
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4.5 13.7 9l4.5 1.7-4.5 1.7L12 17l-1.7-4.6L5.8 10.7 10.3 9Z" />
          <path d="M18 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7Z" />
        </svg>
        Generate
      </button>

      <div className="rail-spacer" />

      <button type="button" className="rail-btn" onClick={onSettings} title="Settings">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3.1" />
          <path d="M19.4 14.5a1.6 1.6 0 0 0 .32 1.77l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.6 1.6 0 0 0-1.77-.32 1.6 1.6 0 0 0-1 1.47V21a2 2 0 0 1-4 0v-.1a1.6 1.6 0 0 0-1.05-1.47 1.6 1.6 0 0 0-1.77.32l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.6 1.6 0 0 0 .32-1.77 1.6 1.6 0 0 0-1.47-1H3a2 2 0 0 1 0-4h.1a1.6 1.6 0 0 0 1.47-1.05 1.6 1.6 0 0 0-.32-1.77l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.6 1.6 0 0 0 1.77.32H9a1.6 1.6 0 0 0 1-1.47V3a2 2 0 0 1 4 0v.1a1.6 1.6 0 0 0 1 1.47 1.6 1.6 0 0 0 1.77-.32l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.6 1.6 0 0 0-.32 1.77V9a1.6 1.6 0 0 0 1.47 1H21a2 2 0 0 1 0 4h-.1a1.6 1.6 0 0 0-1.47 1Z" />
        </svg>
        Settings
      </button>

      {/* The shuffle bag. It empties as the library is played through and only
          refills once everything has had a turn, so this is a real reading of
          how much is left to hear rather than a decoration. */}
      {bagSize > 0 && (
        <div
          className="bag"
          title={`${bagRemaining} of ${bagSize} still to play before anything repeats`}
        >
          <span className="bag-key">Bag</span>
          <div className="bag-tube">
            <div
              className="bag-fill"
              style={{ height: `${Math.round((bagRemaining / bagSize) * 100)}%` }}
            />
          </div>
          <span className="bag-count">{bagRemaining}</span>
        </div>
      )}
    </nav>
  );
}
