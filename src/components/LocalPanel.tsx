import { useEffect, useState } from "react";

import { EVENTS, onBackendEvent, pickMusicFolders } from "../api";
import type { ScanProgress, ScanReport } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Runs the scan and reports the outcome; owned by App so it can reload. */
  onScan: (paths: string[]) => Promise<ScanReport | null>;
  scanning: boolean;
}

/**
 * Adopting music already on the machine.
 *
 * A drawer rather than a bare folder chooser, for one reason: the system
 * chooser only lists the XDG folders in its sidebar, and a NAS mount, an
 * external disk or anything under /mnt is several clicks down "Other
 * Locations" — if it is reachable at all. Typing the path always works, so the
 * box is the primary control and Browse is the convenience.
 */
export function LocalPanel({ open, onClose, onScan, scanning }: Props) {
  const [text, setText] = useState("");
  const [progress, setProgress] = useState<ScanProgress | null>(null);
  const [report, setReport] = useState<ScanReport | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  useEffect(
    () =>
      onBackendEvent<ScanProgress>(EVENTS.localScan, (next) => {
        setProgress(next.done >= next.total ? null : next);
      }),
    [],
  );

  const paths = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const scan = (): void => {
    if (paths.length === 0) return;
    setReport(null);
    void onScan(paths).then((next) => {
      if (next !== null) setReport(next);
    });
  };

  return (
    <>
      <div
        className={open ? "gp-scrim is-open" : "gp-scrim"}
        onClick={onClose}
        aria-hidden="true"
      />
      <section
        className={open ? "genpanel is-open" : "genpanel"}
        aria-label="Add music from this machine"
        aria-hidden={!open}
      >
        <header className="gp-head">
          <span className="gp-title">Add music from this machine</span>
          <button type="button" className="gp-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="gp-body">
          <section className="gp-section">
            <h2 className="gp-section-key">Folders to search</h2>
            <textarea
              className="input is-area"
              rows={4}
              value={text}
              spellCheck={false}
              placeholder={
                "/home/you/Music\n/mnt/nas/albums\n…one folder or file per line"
              }
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  scan();
                }
              }}
              aria-label="Folders to search for audio"
            />

            <div className="gp-row">
              <button
                type="button"
                className="btn is-primary"
                onClick={scan}
                disabled={scanning || paths.length === 0}
              >
                {scanning ? "Searching…" : `Add ${paths.length || ""}`.trim()}
              </button>
              <button
                type="button"
                className="btn"
                disabled={scanning}
                onClick={() => {
                  void pickMusicFolders().then((chosen) => {
                    if (chosen.length === 0) return;
                    setText((current) =>
                      current.trim() === "" ? chosen.join("\n") : `${current.trim()}\n${chosen.join("\n")}`,
                    );
                  });
                }}
              >
                Browse…
              </button>
            </div>

            <p className="gp-note">
              Paths are typed or pasted because the system folder chooser cannot always reach a
              network share or an external disk. Dragging folders onto the window works too.
            </p>
          </section>

          <section className="gp-section">
            <h2 className="gp-section-key">What happens</h2>
            <p className="gp-note">
              Sub-folders are searched, and mp3, flac, m4a, ogg, opus and wav are picked up. Each
              track is titled from the file’s own tags, falling back to its name. Nothing is copied
              or moved — a track points at the file where it already lives, so removing it from the
              library never touches your collection. Running this again on the same folder adds only
              what is new, and repairs any track still going by its filename.
            </p>
          </section>

          {progress !== null && (
            <section className="gp-section">
              <h2 className="gp-section-key">Searching</h2>
              <div className="gp-bar">
                <div
                  className="gp-bar-fill"
                  style={{
                    width: `${progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%`,
                  }}
                />
              </div>
              <p className="gp-detail">
                {progress.done} of {progress.total} — {progress.current}
              </p>
            </section>
          )}

          {report !== null && (
            <section className="gp-section">
              <h2 className="gp-section-key">Result</h2>
              <p className="dl-report-line">
                {report.added} added · {report.skipped} already in the library
                {report.updated > 0 ? ` · ${report.updated} retitled` : ""} · {report.failed} could
                not be read
                {report.truncated ? " · stopped at the 20,000-file limit" : ""}
              </p>
              {report.errors.map((line, index) => (
                <p className="dl-report-reason" key={`${line}-${index}`}>
                  {line}
                </p>
              ))}
            </section>
          )}
        </div>
      </section>
    </>
  );
}
