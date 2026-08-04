import { useEffect, useState } from "react";

import { appVersion, checkForUpdate, installUpdate, mediaKeyStatus, pickSaveFolder } from "../api";
import type { UpdateInfo } from "../api";
import type { MediaKeys, Stats } from "../types";

/** Where each preference is remembered. Shared with the panels that use them. */
export const CROSSFADE_KEY = "music-ai-player.crossfade";
export const DESTINATION_KEY = "music-ai-player.youtube.destination";

interface Props {
  open: boolean;
  onClose: () => void;
  stats: Stats;
  crossfade: number;
  onCrossfade: (seconds: number) => void;
}

/**
 * Settings.
 *
 * Only things that are genuinely a preference — a choice with no right answer
 * that the app cannot make for the user. Everything else stays where it is
 * used: the genre filter is in the transport because it changes what plays
 * next, and the library refresh is in the library header because that is what
 * it acts on. A settings screen that collects every control in the app is
 * where controls go to be lost.
 */
export function SettingsPanel({ open, onClose, stats, crossfade, onCrossfade }: Props) {
  const [keys, setKeys] = useState<MediaKeys | null>(null);
  const [destination, setDestination] = useState<string | null>(() =>
    window.localStorage.getItem(DESTINATION_KEY),
  );
  const [version, setVersion] = useState("");
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState<number | null>(null);
  const [updateNote, setUpdateNote] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return undefined;
    void mediaKeyStatus().then(setKeys);
    void appVersion().then(setVersion);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  const saveDestination = (dir: string | null): void => {
    setDestination(dir);
    if (dir === null) window.localStorage.removeItem(DESTINATION_KEY);
    else window.localStorage.setItem(DESTINATION_KEY, dir);
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
        aria-label="Settings"
        aria-hidden={!open}
      >
        <header className="gp-head">
          <span className="gp-title">Settings</span>
          <button type="button" className="gp-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="gp-body">
          <section className="gp-section">
            <h2 className="gp-section-key">Crossfade</h2>
            <div className="gp-row gp-slider">
              <input
                className="range is-wide"
                type="range"
                min={0}
                max={16}
                step={0.5}
                value={crossfade}
                onChange={(event) => onCrossfade(Number(event.target.value))}
                aria-label="Crossfade length in seconds"
              />
              <span className="gp-stat-val">
                {crossfade === 0 ? "off" : `${crossfade.toFixed(1)}s`}
              </span>
            </div>
            <p className="gp-note">
              How long two tracks overlap at a change. A track shorter than twice this hands over
              across half its own length instead, so a short one is still heard on its own.
            </p>
          </section>

          <section className="gp-section">
            <h2 className="gp-section-key">Downloads</h2>
            <div className="gp-row gp-dest">
              <span className="gp-path is-grow" title={destination ?? undefined}>
                {destination ?? "the library’s tracks folder"}
              </span>
              <button
                type="button"
                className="btn is-small"
                onClick={() => {
                  void pickSaveFolder(destination).then((chosen) => {
                    if (chosen !== null) saveDestination(chosen);
                  });
                }}
              >
                Browse
              </button>
              {destination !== null && (
                <button
                  type="button"
                  className="btn is-small"
                  onClick={() => saveDestination(null)}
                >
                  Reset
                </button>
              )}
            </div>
          </section>

          <section className="gp-section">
            <h2 className="gp-section-key">Library</h2>
            <p className="gp-path">{stats.libraryPath === "" ? "not found" : stats.libraryPath}</p>
            <p className="gp-note">
              {stats.ready} ready · {stats.total} rows in total. Set <code>MUSIC_AI_LIBRARY</code>{" "}
              before launching to point somewhere else.
            </p>
          </section>

          <section className="gp-section">
            <h2 className="gp-section-key">Updates</h2>
            <div className="gp-row gp-dest">
              <span className="gp-path is-grow">
                Version {version === "" ? "…" : version}
                {update !== null ? ` — ${update.version} is available` : ""}
              </span>
              {update === null ? (
                <button
                  type="button"
                  className="btn is-small"
                  disabled={checking}
                  onClick={() => {
                    setChecking(true);
                    setUpdateNote(null);
                    void checkForUpdate()
                      .then((found) => {
                        setUpdate(found);
                        if (found === null) setUpdateNote("This is the newest build.");
                      })
                      .catch((err: unknown) =>
                        setUpdateNote(err instanceof Error ? err.message : String(err)),
                      )
                      .finally(() => setChecking(false));
                  }}
                >
                  {checking ? "Checking…" : "Check"}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn is-primary is-small"
                  disabled={installing !== null}
                  onClick={() => {
                    setInstalling(0);
                    setUpdateNote(null);
                    void installUpdate(setInstalling).catch((err: unknown) => {
                      setUpdateNote(err instanceof Error ? err.message : String(err));
                      setInstalling(null);
                    });
                  }}
                >
                  {installing === null
                    ? "Install and restart"
                    : `${Math.round(installing * 100)}%`}
                </button>
              )}
            </div>
            {installing !== null && (
              <div className="gp-bar">
                <div className="gp-bar-fill" style={{ width: `${installing * 100}%` }} />
              </div>
            )}
            {update !== null && update.notes !== "" && (
              <p className="gp-note">{update.notes}</p>
            )}
            {updateNote !== null && <p className="gp-note">{updateNote}</p>}
            <p className="gp-note">
              Updates are downloaded from the project's GitHub releases and checked against a
              signing key built into this app, so a tampered download is refused rather than
              installed. Installing replaces the running AppImage and restarts it.
            </p>
          </section>

          <section className="gp-section">
            <h2 className="gp-section-key">Media keys</h2>
            {keys === null ? (
              <p className="gp-note">checking…</p>
            ) : keys.unclaimed.length === 0 ? (
              <p className="gp-note">Play, pause, next and previous are bound.</p>
            ) : (
              <p className="gp-note is-warn">
                {keys.unclaimed.join(", ")} already belongs to another application. The tray menu
                always works.
              </p>
            )}
          </section>
        </div>
      </section>
    </>
  );
}
