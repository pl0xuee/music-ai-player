# Engine notes — ACE-Step 1.5 on RX 9070 XT (RDNA4 / gfx1201)

Hard-won details about running ACE-Step on this specific machine. Read before
touching `start-api.sh`.

## Hardware / OS

| | |
|---|---|
| GPU | AMD Radeon RX 9070 XT — **RDNA4, gfx1201**, 16 GB VRAM |
| OS | CachyOS (Arch), kernel 7.1.5 |
| System ROCm | 7.2.4 (`extra/rocm-hip-sdk`) |
| Python | **3.11 required** by ACE-Step; system default is 3.14 — hence `uv` |

The vendor's ROCm manual is explicitly tested on **RDNA4 + CachyOS**, which is
this exact stack. That's the main reason this approach was chosen.

## ⚠️ The RDNA4 trap

**Do not use the vendored `start_api_server_rocm.sh`.** It is written for RDNA3
("For AMD RX 7000/6000 series GPUs") and does two things that are wrong here:

1. **`HSA_OVERRIDE_GFX_VERSION=11.0.0`** — forces an RDNA3 architecture ID.
   RDNA4/gfx1201 has *native* ROCm support from 6.4 onward, so an override
   misreports the ISA and breaks kernel selection. `start-api.sh` explicitly
   `unset`s it. Note the vendor's own RDNA4 manual never sets one — consistent
   with this reading.

2. **`CHECK_UPDATE="true"`** — blocks on an interactive `read -rp` prompt. That
   deadlocks any programmatic spawn, which is precisely how the Tauri app
   launches the engine. Not reproduced in our launcher.

## Required environment

Set by `start-api.sh`; all of these have a specific reason.

| Variable | Value | Why |
|---|---|---|
| `HSA_OVERRIDE_GFX_VERSION` | **unset** | See above. RDNA4 is native. |
| `MIOPEN_FIND_MODE` | `FAST` | Without it the first VAE decode hangs for *minutes per conv layer* doing exhaustive kernel benchmarking. |
| `ACESTEP_LM_BACKEND` | `pt` | nano-vllm needs flash_attn, which has no usable ROCm build. Vendor's documented AMD workaround. |
| `ACESTEP_INIT_LLM` | `auto` | Auto-enables above 6 GB VRAM; 16 GB clears it easily. |
| `PYTORCH_HIP_ALLOC_CONF` | `expandable_segments:True` | Limits fragmentation across a long batch run. |
| `TOKENIZERS_PARALLELISM` | `false` | Silences HF fork warnings. |

## PyTorch wheel choice

PyTorch ROCm wheels **bundle their own ROCm runtime**, so the wheel need not
match system ROCm exactly — it only needs native gfx1201 support, which landed
in ROCm 6.4. All of `rocm6.4`, `rocm7.0`, `rocm7.1`, `rocm7.2` are published.

Default is `rocm7.0` (mature, well clear of the RDNA4 threshold). Fallback
ladder if the GPU isn't detected or generation misbehaves:

```
ROCM_WHEEL=rocm7.2 ./engine/setup.sh    # matches system ROCm exactly
ROCM_WHEEL=rocm6.4 ./engine/setup.sh    # what the vendor manual pins
```

The vendor script's header suggests `rocm6.3` — too old for RDNA4. Ignore it.

Because torch bundles its runtime, the full `rocm-hip-sdk` (very large) is
likely unnecessary; `rocminfo` + `rocm-smi-lib` are enough for detection and
monitoring. Escalate to the full SDK only if `setup.sh` fails its GPU check.

## ⚠️ Two traps that cost us the first run

Both were found the hard way and are now handled in `generate.py`. Do not
"simplify" either one away.

### 1. `audio_format: "opus"` silently produces NO FILE

The audio renders fine; only the *write* fails, and `inference.py` swallows the
exception and returns an empty path — so the task reports **success** with
`"file": ""` and you download nothing.

Cause: torchaudio 2.10 dropped its own encoders and delegates to **torchcodec,
which is not installed**; the soundfile fallback doesn't recognise `OPUS` as a
container.

| Format | Works? | Notes |
|---|---|---|
| `mp3` | ✅ | via system ffmpeg. ~3.2 MB per 200 s (128 kbps). **Default.** |
| `flac` | ✅ | lossless, ~8.7 MB per 200 s |
| `wav`, `wav32` | ✅ | huge |
| `opus`, `aac` | ❌ | always fail |
| `ogg` | ⚠️ | silently downgraded to flac, yields a `.flac` file |

mp3 at 128 kbps lands the 432-track library at ~1.4 GB — the same ballpark opus
would have, so nothing was lost.

### 2. `use_cot_caption` defaults to TRUE and rewrites your prompt

This is the dangerous one, because it fails *quietly and plausibly*. The LM
expands your tags into prose and **replaces** the caption before DiT
conditioning (`inference.py`: `dit_input_caption = lm_generated_metadata.get("caption", …)`).

Observed: `dark techno, driving, hypnotic, analog, warehouse, 138 bpm` became
*"An energetic progressive **trance** track…"*. Every bit of genre control in
`prompts.toml` is worthless if this is on — a whole 24 h library would drift.

Set `use_cot_caption: false`. Verify passthrough in the server log:

```
conditioning_text:_prepare_text_conditioning_inputs - text_prompt:
# Caption
dark techno, driving, hypnotic, analog, warehouse, relentless, 138 bpm
```

`use_cot_metas` is not exposed on the API (hardcoded `True`), leaving a ~2.4 s
LM metadata pass. Supplying `bpm`, `key_scale`, `time_signature` and
`audio_duration` makes it a no-op.

## REST API

Launched by `acestep/api_server.py --host 127.0.0.1 --port 8001`. FastAPI, so
there are live docs at `/docs` — though `release_task` is free-form there, so
the source is the real contract.

| Call | Method | Purpose |
|---|---|---|
| `/release_task` | POST | submit → `{data: {task_id}}`; **429 when the queue (max 200) is full** |
| `/query_result` | POST | `{task_id_list: [...]}` → `status` 0 = running, 1 = ok, 2 = failed |
| `/v1/audio?path=…` | GET | download bytes |
| `/v1/stats` | GET | `avg_job_seconds` etc. |

**The working payload** (as sent by `generate.py`):

```jsonc
{
  "prompt": "dark techno, driving, hypnotic, analog, warehouse, 138 bpm",
  "lyrics": "",              // empty ⇒ INSTRUMENTAL
  "audio_duration": 200,     // 10–600 s (480 max with the LM loaded)
  "bpm": 138, "key_scale": "F Minor", "time_signature": "4/4",
  "audio_format": "mp3",     // NOT opus — see above
  "seed": -1, "use_random_seed": true,
  "use_cot_caption": false,  // ← the one that matters
  "use_cot_language": false, "use_format": false, "sample_mode": false,
  "thinking": false, "full_analysis_only": false, "analysis_only": false,
  "inference_steps": 8, "guidance_scale": 7.0,
  "model": "acestep-v15-turbo", "batch_size": 1, "task_type": "text2music"
}
```

### Reading the response

`data[0].result` is a **JSON-encoded string** holding an **array** — one element
per rendered audio, so `batch_size: N` gives N entries from one call. Each
element's `file` is an already-percent-encoded relative URL:

```
"file": "/v1/audio?path=%2Fhome%2F…%2Fapi_audio%2F<uuid>.mp3"
```

Append it to the base URL **as-is** — do not re-encode. `wave` is a dead legacy
field, always `""`.

`result.prompt` is **not your input** — it's the LM-rewritten caption (empty
when CoT is off), and `genres` is always `"N/A"`. Track your own metadata
client-side; `generate.py` does.

### Other things that bite a 432-track run

- **Nothing garbage-collects the output dir.** Files persist at
  `<acestep>/.cache/acestep/tmp/api_audio/<uuid>.<ext>`. `generate.py` copies
  them into `library/tracks/`; prune the cache yourself periodically.
- **Filename collisions.** The uuid is a deterministic hash of the params
  *including seed*, so a pinned seed with identical params silently overwrites.
  Keep `use_random_seed: true`.
- **The random seed is unrecoverable** from the response (`diskcache` isn't
  installed, so the in-memory store path omits `seed_value`). Pin your own seed
  if you need reproducibility.
- **One worker** — requests serialize no matter what you do.
- `progress_text` is a global log tail, not per-job.

## Benchmarks (measured on this machine)

The server self-reports its limits at startup — 15.92 GB puts it in **tier6a**:

| | |
|---|---|
| Max batch size | **4** with LM loaded, 8 without |
| Max duration | 480 s with LM, 600 s without |
| Workers | 1 (requests serialize) |

Measured at `inference_steps: 8`, `batch_size: 1`:

| Track length | Wall clock | Notes |
|---|---|---|
| 30 s | ~12 s | |
| 200 s | ~54 s | ≈3.7× faster than realtime |

**432 × 200 s tracks ≈ 6.5 h** at `batch_size: 1`. That's an overnight run.

`batch_size` is the lever to shorten it, but note what it actually does: it
produces N variations of the **same prompt**, not N different tracks. So it
trades library diversity for speed. Given that "everything sounds samey" is the
main risk to this project, `batch_size: 1` is the default and going higher
should be a deliberate choice.

Watch VRAM while sweeping: `/opt/rocm/bin/rocm-smi --showmeminfo vram`

## Models

- `acestep-v15-turbo` — 2 B DiT, ~4.7 GB. **Default.** Speed matters most across
  432 tracks, and the small footprint is what allows a larger `batch_size`.
- XL variants — 4 B DiT, ~9 GB. Higher quality, smaller batches. Expose later as
  a toggle; don't start here.

## Troubleshooting

**Server starts, first request hangs for minutes** — `MIOPEN_FIND_MODE=FAST`
missing. Most likely cause by far.

**`torch.cuda.is_available()` is False** — walk the wheel ladder above; confirm
`rocminfo | grep gfx1201`; check the user is in the `render`/`video` groups.

**Out of memory during batch** — lower `batch_size`; confirm
`PYTORCH_HIP_ALLOC_CONF=expandable_segments:True`; make sure no leftover engine
process is still holding VRAM (`ps aux | grep api_server`).

**Generation quality is poor / not dark enough** — that's a `prompts.rs`
problem, not an engine problem. Tune the tag bank.
