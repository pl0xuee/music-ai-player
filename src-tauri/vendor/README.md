# Patched GLib Rust bindings

`glib/` is the crates.io `glib` **0.18.5** source, with the two-line upstream
fix for [RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)
backported to `src/variant_iter.rs`. The C out-argument is now a mutable
reference to a mutable pointer. The source change is identical to
[gtk-rs-core PR #1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343/files).

## Provenance and scope

- Registry archive: `https://static.crates.io/crates/glib/glib-0.18.5.crate`
- Archive SHA-256: `233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`
- Upstream source commit: `42b9caf98e03ded086362d9653ca58fe94dc8658`
  (recorded in `glib/.cargo_vcs_info.json`).
- Upstream `LICENSE`, `COPYRIGHT`, manifests, sources and tests are retained.
  Cargo's local cache marker/checksum files are excluded.
- `glib` keeps its actual version, 0.18.5. No other upstream source is changed.

The archive checksum and extracted files were verified before applying the
patch. This is a project-maintained backport, not an upstream 0.18 release.

## Why a local patch

Tauri's GTK3/WebKit dependencies require the 0.18 bindings. Adding glib 0.20
does not upgrade those dependencies. The `[patch.crates-io]` entry in the app's
`Cargo.toml` makes all crates using glib 0.18 resolve to this checked-in copy.
It also makes the patch available to clean checkouts and release builds.

This fixes this advisory's code defect; it does not make the older GTK stack
maintained or resolve unrelated advisories. No security alerts are suppressed.
A version-based scanner may still flag 0.18.5; use the patch and test evidence
when reviewing that finding. Do not represent this as an upgrade to 0.20.
Existing installed binaries need to be rebuilt and distributed to get the fix.

## Verification

From the repository root:

```sh
cargo tree --locked --manifest-path src-tauri/Cargo.toml -i glib@0.18.5
cargo test --locked --release --manifest-path src-tauri/Cargo.toml --test glib_variant_str_iter
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

The dependency tree must point to `src-tauri/vendor/glib`. The Linux regression
tests exercise every affected iterator method, including forward/reverse reads,
skipping, the last element, Unicode, empty strings and exhausted iterators.
The release workflow runs these tests with optimizations before publishing.
For a standalone release-mode test run, build the frontend first (`npm run build`)
if `dist/` does not exist, since Tauri's release binary embeds those assets.

On Rust 1.98.0 with system GLib 2.88.3, a temporary minimal harness running
these same iterator assertions in release mode crashed with SIGSEGV against
the unmodified crates.io 0.18.5, then passed both tests with this backport.

## Removing the backport

When the complete GTK/WebKit/Tauri stack can resolve to an upstream patched
glib release (0.20 or later), upgrade that stack, remove the patch entry and
vendored source, and regenerate the app's lockfile. Verify there are no affected
glib versions left, then rerun the regression tests and app checks. Keep the
regression tests as coverage through that migration.
