import { useCallback, useEffect, useRef, useState } from "react";

import {
  onDownloads,
  youtubeCancel,
  youtubeCancelAll,
  youtubeClearFinished,
  youtubeImport,
  youtubeJobs,
  youtubeStatus,
} from "../api";
import type { DownloadJob, ImportReport, Playlist, YtTools } from "../types";
import { EMPTY_TOOLS, isSettled } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  playlists: Playlist[];
  /** Pre-selected target, so the playlist panel's button lands in the right place. */
  targetId: number | null;
  onTarget: (id: number | null) => void;
  /** Fired whenever a download commits a row, so the library reloads. */
  onLibraryChanged: () => void;
  /** Live count for the rail badge. */
  onActiveChange: (count: number) => void;
}

/**
 * The import drawer.
 *
 * A drawer rather than a modal for the same reason the generator is one: a
 * 40-track playlist takes a while and the music has to keep playing behind it.
 * Always mounted, so the queue keeps streaming in with the drawer shut.
 */
export function YouTubePanel(props: Props) {
  const { open, onClose, playlists, targetId, onTarget, onLibraryChanged, onActiveChange } = props;

  const [tools, setTools] = useState<YtTools>(EMPTY_TOOLS);
  const [jobs, setJobs] = useState<DownloadJob[]>([]);
  const [text, setText] = useState("");
  const [wholePlaylist, setWholePlaylist] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Committed-row count from the last snapshot. A change in it — not a change
  // in job state — is what actually means "there is new audio in the library".
  const committedRef = useRef(0);
  const onLibraryChangedRef = useRef(onLibraryChanged);
  const onActiveChangeRef = useRef(onActiveChange);
  useEffect(() => {
    onLibraryChangedRef.current = onLibraryChanged;
    onActiveChangeRef.current = onActiveChange;
  });

  const absorb = useCallback((next: DownloadJob[]) => {
    setJobs(next);
    onActiveChangeRef.current(next.filter((job) => !isSettled(job)).length);

    const committed = next.reduce((total, job) => total + job.added, 0);
    if (committed !== committedRef.current) {
      committedRef.current = committed;
      onLibraryChangedRef.current();
    }
  }, []);

  useEffect(() => {
    void youtubeJobs().then(absorb);
    return onDownloads(absorb);
  }, [absorb]);

  // Re-checked on every open so installing yt-dlp mid-session is noticed.
  useEffect(() => {
    if (!open) return;
    void youtubeStatus().then(setTools);
  }, [open]);

  const submit = (): void => {
    if (text.trim().length === 0) return;
    setBusy(true);
    setError(null);
    void youtubeImport(text, targetId, wholePlaylist)
      .then((next) => {
        setReport(next);
        // Keep whatever was rejected in the box so it can be fixed, and clear
        // the rest — retyping 30 good URLs to fix one typo is not a workflow.
        const failed = next.lines.filter((line) => !line.accepted && line.jobId === null);
        setText(failed.map((line) => line.input).join("\n"));
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  const active = jobs.filter((job) => !isSettled(job));
  const blocked = tools.blocker !== null;

  return (
    <>
      <div
        className={open ? "gp-scrim is-open" : "gp-scrim"}
        onClick={onClose}
        aria-hidden="true"
      />
      <section
        className={open ? "genpanel is-open" : "genpanel"}
        aria-label="Add from YouTube"
        aria-hidden={!open}
      >
        <header className="gp-head">
          <span className="gp-title">Add from YouTube</span>
          <button type="button" className="gp-close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <div className="gp-body">
          <section className="gp-section">
            <h2 className="gp-section-key">Downloader</h2>
            <div className="gp-engine">
              <span className={blocked ? "gp-dot" : "gp-dot is-online"} aria-hidden="true" />
              <span className="gp-state">{blocked ? "unavailable" : "ready"}</span>
              <span className="gp-detail">
                {tools.version !== null ? `yt-dlp ${tools.version}` : "yt-dlp not found"}
              </span>
            </div>
            {tools.blocker !== null && <p className="gp-note is-warn">{tools.blocker}</p>}
            {!blocked && <p className="gp-path">Audio lands in {tools.tracksDir}</p>}
          </section>

          <section className="gp-section">
            <h2 className="gp-section-key">Paste one or many links</h2>
            <textarea
              className="input is-area"
              rows={5}
              value={text}
              disabled={blocked}
              placeholder={"https://youtu.be/…\nhttps://www.youtube.com/watch?v=…\n…one per line"}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                // Enter is a newline in a textarea; Ctrl/Cmd-Enter submits.
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  submit();
                }
              }}
              aria-label="YouTube URLs"
            />

            <div className="gp-row">
              <select
                className="select is-wide"
                value={targetId ?? ""}
                disabled={blocked}
                onChange={(event) =>
                  onTarget(event.target.value === "" ? null : Number(event.target.value))
                }
                aria-label="Add to playlist"
              >
                <option value="">Library only</option>
                {playlists.map((playlist) => (
                  <option key={playlist.id} value={playlist.id}>
                    Add to “{playlist.name}”
                  </option>
                ))}
              </select>
            </div>

            <label className="gp-check">
              <input
                type="checkbox"
                checked={wholePlaylist}
                disabled={blocked}
                onChange={(event) => setWholePlaylist(event.target.checked)}
              />
              <span>
                Expand playlists — a link with a <code>list=</code> downloads every entry, not
                just the one video.
              </span>
            </label>

            <div className="gp-row">
              <button
                type="button"
                className="btn is-primary"
                onClick={submit}
                disabled={blocked || busy || text.trim().length === 0}
              >
                {busy ? "Queueing…" : "Download"}
              </button>
              {active.length > 0 && (
                <button type="button" className="btn" onClick={() => void youtubeCancelAll()}>
                  Cancel all
                </button>
              )}
              {jobs.some(isSettled) && (
                <button type="button" className="btn" onClick={() => void youtubeClearFinished()}>
                  Clear finished
                </button>
              )}
            </div>

            {error !== null && <p className="gp-note is-warn">{error}</p>}
            {report !== null && <Report report={report} />}
          </section>

          <section className="gp-section">
            <h2 className="gp-section-key">
              Queue{active.length > 0 ? ` — ${active.length} running` : ""}
            </h2>
            {jobs.length === 0 ? (
              <p className="gp-note">Nothing queued.</p>
            ) : (
              <div className="dl-list">
                {[...jobs].reverse().map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </div>
            )}
          </section>
        </div>
      </section>
    </>
  );
}

function Report({ report }: { report: ImportReport }) {
  const summary = [
    report.queued > 0 ? `${report.queued} queued` : null,
    report.duplicates > 0 ? `${report.duplicates} already held` : null,
    report.rejected > 0 ? `${report.rejected} not a YouTube link` : null,
  ].filter((part): part is string => part !== null);

  return (
    <div className="dl-report">
      <p className="gp-note">{summary.length > 0 ? summary.join(" · ") : "Nothing to do."}</p>
      {report.lines
        .filter((line) => !line.accepted)
        .map((line, index) => (
          <p className="dl-report-line" key={`${line.input}-${index}`}>
            <span className="dl-report-input">{line.input}</span>
            <span className="dl-report-reason">{line.reason}</span>
          </p>
        ))}
    </div>
  );
}

function JobRow({ job }: { job: DownloadJob }) {
  const running = job.phase === "running";
  const live = running && job.percent > 0;

  return (
    <div className={`dl-job is-${job.phase}`}>
      <div className="dl-job-head">
        <span className="dl-job-title" title={job.url}>
          {job.label}
        </span>
        {job.phase === "queued" || running ? (
          <button
            type="button"
            className="icon"
            onClick={() => void youtubeCancel(job.id)}
            aria-label={`Cancel ${job.label}`}
            title="Cancel"
          >
            ✕
          </button>
        ) : (
          <span className="dl-job-phase">{job.phase}</span>
        )}
      </div>
      <div className="gp-bar">
        <div
          className={live ? "gp-bar-fill is-live" : "gp-bar-fill"}
          style={{ width: `${running ? job.percent : job.phase === "done" ? 100 : 0}%` }}
        />
      </div>
      <p className="dl-job-detail">
        {running && job.percent > 0 && (
          <span className="dl-job-pct">{job.percent.toFixed(0)}%</span>
        )}
        {job.detail}
      </p>
    </div>
  );
}
