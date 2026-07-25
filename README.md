# AI Biodiversity Survey Coach — Offline Pack v17

Static, no-framework learning application for recording local biodiversity
observations, calculating operational-category metrics, practising CER
(Claim–Evidence–Reasoning), and exporting a report.

Current application-shell cache: `biodiversity-offline-v17`.

## Run locally

Serve the repository over HTTP; service workers and IndexedDB do not work
reliably when `index.html` is opened directly as a `file://` URL.

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Load the application online once and wait
for the service worker to install before relying on the offline shell.

The required application shell (HTML, manifest, icons, and utility modules)
must install successfully. Optional classification, chart, and PDF libraries
are attempted separately, so an unavailable optional file does not block the
manual application shell. The interface reports unavailable optional features
and provides recovery guidance instead of claiming they are ready.

The optional browser libraries are vendored in the repository. Run
`./get_libs.sh` from the repository directory, or invoke the script by its path
from any working directory. Run `get_libs.ps1` with PowerShell to check the
release files. These scripts only validate files beside the scripts; they do
not download dependencies. If a library is missing, restore a complete release
package.

## Data, privacy, and clearing

- Observation records and downscaled image data URLs are stored in IndexedDB
  on the current browser profile and device.
- Application code does not transmit stored survey records to a server.
- Pre/post/practice assessment state, Coach history, active classification
  requests, rendered reports, and service-worker caches are not stored in the
  survey snapshot.
- **Hapus Data Survei Lokal** clears only the persisted survey. Browser
  controls are still needed to remove all site data and caches.
- Clearing browser/site data, using a private session, or losing browser
  storage can remove the survey. There is no account, synchronization, or
  backup service.

## Offline boundaries

The required application shell, utility modules, manifest, and icons are
precached atomically after a successful online installation. Available optional
browser libraries are cached individually. Saved observations can then be
restored, edited, analysed, reported, and cleared offline; a missing optional
library affects only its associated feature.

MobileNet model weights are not packaged in the application shell. First-run
offline classification is therefore not guaranteed. If the model is
unavailable, manual labelling remains available. Model output is an unverified
candidate, not a verified taxonomic identification.

## Assessment and analysis boundaries

- Assessment scores exist only after explicit submission; missing evidence is
  shown as `Belum diukur`.
- A score of zero is valid. Pre, post, and practice sessions are isolated.
- Biodiversity analysis is derived from current valid observations. Invalid
  counts and unresolved identifications are excluded with explicit reasons.
- Operational categories may be broad or unverified labels and are not
  automatically equivalent to species.
- Shannon interpretation is bounded descriptive feedback, not proof of
  ecosystem quality or educational validity.

## Development and tests

Requires Node.js:

```bash
npm install
npm test -- --reporter=verbose
```

The eight Vitest suites cover assessment state, current-state biodiversity
analysis, classification request ownership, canonical observation records,
bounded Shannon interpretation, label sanitisation, IndexedDB persistence, and
PWA/service-worker release behavior. Some integration contracts intentionally
inspect source wiring; browser
verification remains necessary for service-worker, IndexedDB, PDF, focus, and
cross-tab behavior.

`vitest` is a development-only dependency. Browser runtime dependencies are
the vendored files in the repository; no npm production package is loaded by
the application.

## Known limitations

- No persistence synchronization, account, backend, geolocation, or map.
- No first-run offline guarantee for MobileNet weights.
- Exact-match assessment grading is pedagogically limited.
- Browser storage quotas vary; image-heavy surveys can fail to save.
- Concurrent tabs use revision checks and may require a reload after conflict.
- PDF export depends on the bundled `html2canvas` and `jsPDF` libraries.

When changing any precached production asset, update the cache identifier in
`sw.js` and this README together.
