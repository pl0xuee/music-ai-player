import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import {
  engineStart,
  engineStatus as fetchEngineStatus,
  engineStop,
  generationCancel,
  generationStart,
  generationState,
  generationStyles,
  onEngineLog,
  onEngineStatus,
  onGeneration,
  onGenerationLog,
} from "../api";
import { IDLE_RUN, OFFLINE_ENGINE } from "../types";
import type {
  EngineStatus,
  GenerationProgress,
  GenStyle,
  GenTarget,
  LogLine,
} from "../types";
import { hms } from "../format";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Rows the generator planned but has not produced yet — the Resume trigger. */
  pending: number;
  /** Called whenever new tracks may have landed, so the library reloads. */
  onLibraryChanged: () => void;
  /** Lets the run state drive the header badge without a second subscription. */
  onRunChange: (run: GenerationProgress) => void;
}

interface Preset {
  value: string;
  unit: string;
  target: GenTarget;
  note: string;
}

/**
 * Four targets, not a number field. 10 tracks is the "listen before you commit
 * the GPU for a day" sample the engine notes recommend; 24 h is the full
 * library. Anything in between is a rounding decision, not a real choice.
 */
const PRESETS: Preset[] = [
  { value: "10", unit: "tracks", target: { kind: "tracks", value: 10 }, note: "sample batch" },
  { value: "1", unit: "hour", target: { kind: "hours", value: 1 }, note: "~18 tracks" },
  { value: "6", unit: "hours", target: { kind: "hours", value: 6 }, note: "~108 tracks" },
  { value: "24", unit: "hours", target: { kind: "hours", value: 24 }, note: "~432 tracks" },
];

const LOG_LIMIT = 200;

export function GenerationPanel({ open, onClose, pending, onLibraryChanged, onRunChange }: Props) {
  /**
   * Styles to restrict the run to. Empty means every style at the weights the
   * prompt bank gives them, which is what an untargeted run has always done —
   * so the default costs the user no decision.
   */
  const [styles, setStyles] = useState<string[]>([]);
  const [available, setAvailable] = useState<GenStyle[]>([]);
  const [engine, setEngine] = useState<EngineStatus>(OFFLINE_ENGINE);
  const [run, setRun] = useState<GenerationProgress>(IDLE_RUN);
  const [log, setLog] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState(0);
  const [busy, setBusy] = useState(false);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  // -- backend wiring -------------------------------------------------------
  //
  // Subscribed at mount and never torn down while the app lives: a run keeps
  // going with the panel closed (and with the window hidden in the tray), so
  // the panel must be able to re-open onto a run already in flight.

  useEffect(() => {
    let cancelled = false;
    void fetchEngineStatus().then((status) => {
      if (!cancelled) setEngine(status);
    });
    void generationState().then((state) => {
      if (!cancelled) setRun(state);
    });

    const append = (entry: LogLine): void => {
      setLog((lines) => {
        const next = [...lines, entry];
        return next.length > LOG_LIMIT ? next.slice(-LOG_LIMIT) : next;
      });
    };

    const unsubscribe = [
      onEngineStatus(setEngine),
      onGeneration(setRun),
      onEngineLog(append),
      onGenerationLog(append),
    ];
    return () => {
      cancelled = true;
      for (const off of unsubscribe) off();
    };
  }, []);

  useEffect(() => {
    onRunChange(run);
  }, [onRunChange, run]);

  // New rows land in the database as they finish, so reload on each success and
  // once more when the run settles.
  const lastOk = useRef(0);
  useEffect(() => {
    if (run.ok !== lastOk.current) {
      lastOk.current = run.ok;
      if (run.ok > 0) onLibraryChanged();
    }
  }, [onLibraryChanged, run.ok]);

  useEffect(() => {
    if (!run.running && (run.phase === "done" || run.phase === "cancelled" || run.phase === "failed")) {
      onLibraryChanged();
    }
  }, [onLibraryChanged, run.phase, run.running]);

  useEffect(() => {
    if (!open) return;
    // Scroll the console, not the page. `scrollIntoView` walks up and scrolls
    // every scrollable ancestor, which here means the drawer itself — opening
    // it with any log at all would jump straight past its own header.
    const box = logEndRef.current?.parentElement;
    if (box !== null && box !== undefined) box.scrollTop = box.scrollHeight;
  }, [log, open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, open]);

  // Read on every open, so editing prompts.toml is picked up without a restart.
  useEffect(() => {
    if (open) void generationStyles().then(setAvailable);
  }, [open]);

  // -- actions --------------------------------------------------------------

  const guard = useCallback(async (action: () => Promise<unknown>) => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const start = useCallback(
    (target: GenTarget) => {
      void guard(() => generationStart(target, styles));
    },
    [guard, styles],
  );

  // -- derived --------------------------------------------------------------

  const blocked = engine.blocker !== null;
  const online = engine.state === "online";
  const active = run.running;
  const preset = PRESETS[choice] ?? PRESETS[0];
  const fraction = run.total > 0 ? Math.min(1, run.current / run.total) : 0;
  const canStart = online && !active && !blocked && !busy;

  return (
    <>
      <div
        className={open ? "gp-scrim is-open" : "gp-scrim"}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={open ? "genpanel is-open" : "genpanel"}
        aria-label="Generator"
        aria-hidden={!open}
        // Keeps the closed drawer out of the tab order without a display:none
        // that would kill the slide transition.
        inert={!open}
      >
        <header className="gp-head">
          <span className="gp-title">Generator</span>
          <button type="button" className="gp-close" onClick={onClose} aria-label="Close generator">
            ×
          </button>
        </header>

        <div className="gp-body">
          <Section label="Engine">
            <div className="gp-engine">
              <span className={`gp-dot is-${engine.state}`} aria-hidden="true" />
              <span className="gp-state">{engine.state}</span>
              <span className="gp-detail" title={engine.detail}>
                {engine.detail}
              </span>
            </div>

            {blocked ? (
              <p className="gp-note is-warn">{engine.blocker}</p>
            ) : (
              <>
                <div className="gp-row">
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void guard(engineStart)}
                    disabled={busy || engine.state !== "offline"}
                  >
                    Start engine
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void guard(engineStop)}
                    disabled={busy || !engine.supervised || active}
                    title={
                      engine.supervised
                        ? "Stop the ACE-Step server and release its VRAM"
                        : "Only a server this app started can be stopped from here"
                    }
                  >
                    Stop engine
                  </button>
                </div>
                <p className="gp-note">
                  {engine.state === "starting"
                    ? "Loading model weights — the first launch downloads them and takes several minutes."
                    : `ACE-Step REST API on ${engine.apiUrl}. It holds ~13 GB of VRAM while resident.`}
                </p>
              </>
            )}
          </Section>

          {available.length > 0 && (
            <Section label="Style">
              <div className="gp-presets" role="group" aria-label="Styles to generate">
                <button
                  type="button"
                  className={styles.length === 0 ? "chip is-on" : "chip"}
                  aria-pressed={styles.length === 0}
                  onClick={() => setStyles([])}
                  disabled={active}
                >
                  Everything
                </button>
                {available.map((style) => {
                  const on = styles.includes(style.name);
                  return (
                    <button
                      key={style.name}
                      type="button"
                      className={on ? "chip is-on" : "chip"}
                      aria-pressed={on}
                      disabled={active}
                      onClick={() =>
                        setStyles((current) =>
                          current.includes(style.name)
                            ? current.filter((name) => name !== style.name)
                            : [...current, style.name],
                        )
                      }
                    >
                      {style.name}
                      <span className="chip-note">
                        {on ? `${style.bpm[0]}–${style.bpm[1]} BPM` : `${style.share}%`}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="gp-note">
                {styles.length === 0
                  ? "Every style, mixed at the shares shown — one coherent station sound rather than a genre sampler."
                  : `Only ${styles.join(", ")}. Tempo and instrumentation come from the prompt bank; everything else about the run is unchanged.`}
              </p>
            </Section>
          )}

          <Section label="Target">
            <div className="gp-presets" role="radiogroup" aria-label="Generation target">
              {PRESETS.map((option, index) => (
                <button
                  key={option.value + option.unit}
                  type="button"
                  role="radio"
                  aria-checked={index === choice}
                  className={index === choice ? "gp-preset is-on" : "gp-preset"}
                  onClick={() => setChoice(index)}
                  disabled={active}
                >
                  <span className="gp-preset-value">{option.value}</span>
                  <span className="gp-preset-unit">{option.unit}</span>
                  <span className="gp-preset-note">{option.note}</span>
                </button>
              ))}
            </div>

            <div className="gp-row">
              {active ? (
                <button
                  type="button"
                  className="btn is-primary"
                  onClick={() => void guard(generationCancel)}
                  disabled={run.phase === "cancelling"}
                >
                  {run.phase === "cancelling" ? "Cancelling…" : "Cancel"}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn is-primary"
                  onClick={() => {
                    if (preset !== undefined) start(preset.target);
                  }}
                  disabled={!canStart}
                  title={online ? undefined : "The engine has to be running first"}
                >
                  Start
                </button>
              )}

              {pending > 0 && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => start({ kind: "resume" })}
                  disabled={!canStart}
                  title="Continue the prompts an interrupted run left pending"
                >
                  Resume {pending}
                </button>
              )}
            </div>

            {!online && !blocked && (
              <p className="gp-note">
                Generation needs the engine online. generate.py writes its planned rows before it
                checks, so starting against a dead server would only leave debris behind.
              </p>
            )}
          </Section>

          <Section label="Progress">
            <div className="gp-bar" role="progressbar" aria-valuemin={0} aria-valuemax={run.total || 1} aria-valuenow={run.current}>
              <div
                className={active ? "gp-bar-fill is-live" : "gp-bar-fill"}
                style={{ width: `${Math.round(fraction * 100)}%` }}
              />
            </div>

            <div className="gp-stats">
              <Stat label="Done" value={run.total > 0 ? `${run.current}/${run.total}` : "--"} accent={active} />
              <Stat label="Ok" value={String(run.ok)} />
              <Stat label="Failed" value={String(run.failed)} />
              <Stat label="Elapsed" value={hms(run.elapsedSeconds)} />
              <Stat label="ETA" value={active ? hms(run.etaSeconds) : "--"} accent={active} />
            </div>

            <p className="gp-line" title={run.line}>
              {run.genre !== null && active && <span className="gp-genre">{run.genre}</span>}
              {run.line === "" ? "idle" : run.line}
            </p>

            {run.message !== null && (
              <p className={run.phase === "failed" ? "gp-note is-warn" : "gp-note"}>{run.message}</p>
            )}
            {error !== null && <p className="gp-note is-warn">{error}</p>}
          </Section>

          <Section label="Console">
            <div className="gp-log">
              {log.length === 0 ? (
                <span className="gp-log-empty">Nothing yet.</span>
              ) : (
                log.map((entry, index) => (
                  <span
                    key={`${index}-${entry.line.slice(0, 24)}`}
                    className={entry.stderr ? "gp-log-line is-err" : "gp-log-line"}
                  >
                    {entry.line}
                  </span>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </Section>

          <p className="gp-path">
            {engine.generatorPath === "" ? "engine/generate.py" : engine.generatorPath}
          </p>
        </div>
      </aside>
    </>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="gp-section">
      <h2 className="gp-section-key">{label}</h2>
      {children}
    </section>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="gp-stat">
      <span className="gp-stat-key">{label}</span>
      <span className={accent === true ? "gp-stat-val is-live" : "gp-stat-val"}>{value}</span>
    </div>
  );
}
