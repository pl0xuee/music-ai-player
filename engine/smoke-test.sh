#!/usr/bin/env bash
# ------------------------------------------------------------------------------
# Phase 0 gate: generate ONE instrumental dark-techno track end to end.
#
# Exercises the exact three-call contract the Rust batch generator will use:
#   POST /release_task  ->  POST /query_result (poll)  ->  GET /v1/audio
#
# Start the server first (./engine/start-api.sh) in another terminal, then:
#   ./engine/smoke-test.sh
#
# Options:
#   DURATION=30 ./engine/smoke-test.sh    # shorter track for a faster first check
#   BATCH=4     ./engine/smoke-test.sh    # measure throughput at a given batch size
# ------------------------------------------------------------------------------
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${SCRIPT_DIR}/../library/_smoketest"
API="http://${ACESTEP_HOST:-127.0.0.1}:${ACESTEP_PORT:-8001}"

DURATION="${DURATION:-200}"
BATCH="${BATCH:-1}"
MODEL="${MODEL:-acestep-v15-turbo}"
# opus and aac silently produce NO FILE on this install; ogg downgrades to
# flac. mp3 and flac are the only real options. See NOTES.md trap 1.
FORMAT="${FORMAT:-mp3}"

mkdir -p "$OUT_DIR"

# Prefer the venv python for JSON parsing so we don't depend on jq being present.
PY="${SCRIPT_DIR}/ACE-Step-1.5/venv_rocm/bin/python"
[[ -x "$PY" ]] || PY="$(command -v python3)"

say() { printf '\n\033[1;32m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------------------
say "Checking the API is up"
# ------------------------------------------------------------------------------
curl -sf --max-time 10 "${API}/docs" >/dev/null \
    || die "No response from ${API}. Start it with ./engine/start-api.sh"
echo "  ${API} responding"

# ------------------------------------------------------------------------------
say "Submitting generation task"
# ------------------------------------------------------------------------------
# lyrics:"" is what makes this instrumental -- the whole vocals decision.
# The caption is PROSE, not a tag list: ACE-Step is trained on descriptive
# paragraphs and a comma-separated list is out-of-distribution (NOTES.md trap 3).
# audio_format is mp3 because opus cannot be written here at all -- the render
# succeeds and the file write fails silently, so you get an empty path (trap 1).
REQUEST=$(cat <<JSON
{
  "prompt": "A bleak, oppressive dark cyberpunk techno track at 118 BPM. It is built on a deep, rumbling four-on-the-floor kick drum and crisp, tight hi-hats that drive steadily throughout. An enormous sub-bass in the lowest octave dominates everything. A distant, sustained ambient pad hangs behind the groove for the entire track. The production is cold and spacious. Fully instrumental with no vocals.",
  "lyrics": "",
  "audio_duration": ${DURATION},
  "bpm": 118,
  "key_scale": "F Minor",
  "time_signature": "4/4",
  "seed": -1,
  "use_random_seed": true,
  "audio_format": "${FORMAT}",
  "use_cot_caption": false,
  "use_cot_language": false,
  "use_format": false,
  "sample_mode": false,
  "thinking": true,
  "full_analysis_only": false,
  "analysis_only": false,
  "inference_steps": 8,
  "guidance_scale": 7.0,
  "model": "${MODEL}",
  "batch_size": ${BATCH},
  "task_type": "text2music"
}
JSON
)
echo "  duration=${DURATION}s  batch=${BATCH}  model=${MODEL}"

START_TS=$(date +%s)

RESPONSE=$(curl -sf --max-time 60 -X POST "${API}/release_task" \
    -H 'Content-Type: application/json' -d "$REQUEST") \
    || die "release_task failed. Is the model still loading? Check the server log."

TASK_ID=$("$PY" -c '
import json,sys
r = json.load(sys.stdin)
d = r.get("data") or {}
tid = d.get("task_id") or d.get("taskId")
if not tid:
    print("PARSE_FAIL:" + json.dumps(r)[:400]); sys.exit(0)
print(tid)
' <<<"$RESPONSE")

case "$TASK_ID" in
    PARSE_FAIL:*) die "Unexpected response shape: ${TASK_ID#PARSE_FAIL:}" ;;
    "")           die "No task_id in response: $RESPONSE" ;;
esac
echo "  task_id ${TASK_ID}"

# ------------------------------------------------------------------------------
say "Polling for completion"
# ------------------------------------------------------------------------------
# status: 0 = queued/running, 1 = succeeded, 2 = failed
AUDIO_PATH=""
for i in $(seq 1 600); do
    sleep 2
    POLL=$(curl -sf --max-time 30 -X POST "${API}/query_result" \
        -H 'Content-Type: application/json' \
        -d "{\"task_id_list\": [\"${TASK_ID}\"]}") || continue

    PARSED=$("$PY" -c '
import json, sys
r = json.load(sys.stdin)
rows = r.get("data") or []
if not rows:
    print("0|"); raise SystemExit
row = rows[0]
status = row.get("status", 0)
result = row.get("result")
# `result` is documented as a JSON-encoded string; tolerate a real object too.
if isinstance(result, str) and result.strip():
    try: result = json.loads(result)
    except Exception: result = {}
result = result or {}

path = ""
def dig(o):
    global path
    if path or not isinstance(o, (dict, list)): return
    if isinstance(o, dict):
        for k, v in o.items():
            if isinstance(v, str) and v.lower().endswith((".opus",".mp3",".wav",".flac",".aac")):
                path = v; return
            dig(v)
    else:
        for v in o: dig(v)
dig(result)
print(f"{status}|{path}")
' <<<"$POLL")

    STATUS="${PARSED%%|*}"
    FOUND="${PARSED#*|}"

    case "$STATUS" in
        1) AUDIO_PATH="$FOUND"; echo "  succeeded after $((i*2))s"; break ;;
        2) die "Generation FAILED. Check the server log for the traceback." ;;
        *) [[ $((i % 5)) -eq 0 ]] && printf '  ... %ss\n' "$((i*2))" ;;
    esac
done

ELAPSED=$(( $(date +%s) - START_TS ))
[[ -n "$AUDIO_PATH" ]] || die "Timed out after ${ELAPSED}s with no audio path."

# ------------------------------------------------------------------------------
say "Downloading audio"
# ------------------------------------------------------------------------------
ENCODED=$("$PY" -c 'import sys,urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$AUDIO_PATH")
OUT="${OUT_DIR}/smoketest-$(date +%Y%m%d-%H%M%S).${FORMAT}"

curl -sf --max-time 120 "${API}/v1/audio?path=${ENCODED}" -o "$OUT" \
    || die "Download failed for path: $AUDIO_PATH"

[[ -s "$OUT" ]] || die "Downloaded file is empty."

# ------------------------------------------------------------------------------
say "PHASE 0 GATE PASSED"
# ------------------------------------------------------------------------------
SIZE=$(du -h "$OUT" | cut -f1)
echo "  file      $OUT"
echo "  size      $SIZE"
if command -v ffprobe >/dev/null; then
    REAL=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$OUT" 2>/dev/null || echo "?")
    echo "  duration  ${REAL}s (requested ${DURATION}s)"
fi

echo
echo "  ---- BENCHMARK (record these in engine/NOTES.md) ----"
echo "  batch_size        ${BATCH}"
echo "  wall clock        ${ELAPSED}s"
echo "  per track         $(( ELAPSED / BATCH ))s"
echo "  432 tracks ~=     $(( (ELAPSED * 432) / BATCH / 3600 ))h $(( ((ELAPSED * 432) / BATCH % 3600) / 60 ))m"
echo
echo "  Play it:   ffplay -autoexit \"$OUT\""
echo "  Next:      re-run with BATCH=2, then 4, then 8, watching: rocm-smi"
