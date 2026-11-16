# Pendataan Kerusakan Bangunan BPBD Aceh Tamiang

A system for assessing damaged buildings in Aceh Tamiang, in three folders:

| Folder | For | What it is |
|---|---|---|
| [`Survey/`](Survey/README.md) | Field surveyors | The survey app: a map and the data recorded on the device. Titik survei, Evaluasi rekonstruksi and Dokumentasi. Works without signal and uploads to Google Drive. |
| `admin/` | BPBD reviewers and the administrator | Two local pages: **Tinjauan survei** (review uploads, publish approved ones, push to GitHub) and **Alat dasbor** (map datasets, kecamatan tables and text of the Dashboard). |
| [`Dashboard/`](Dashboard/README.md) | Everyone | The public dashboard: disaster data for Aceh Tamiang and the **published** BPBD survey results. Read-only; nothing can be added from it. |

`index.html` is a landing page linking to the survey app and the Dashboard. `titik-survey/` only forwards the old address to `Survey/`.

Live site: https://ttrinug.github.io/pendataan-kerusakan-BPBD-tamiang/ (survey app at `Survey/`, dashboard at `Dashboard/`).

## How data flows

1. Surveyors record houses in **Survey/**. Entries go to a private Google Drive folder.
2. Reviewers get the uploads on **admin/ → Tinjauan survei**, and approve, edit or reject each one.
3. **Terbitkan ke Dashboard** writes the approved records to `Dashboard/data/web/`:
   - `bpbd_survey.geojson`
   - `bpbd_rekonstruksi.geojson`
   - `bpbd_documentation.geojson`
   - the photos in `bpbd_photos/`

   The NIK is cut to its last four digits, signatures are never published, and full names only if ticked.
4. **Unggah ke GitHub** commits only `Dashboard/data/web/` and `Dashboard/config/`, then pushes. The live Dashboard updates a few minutes later.

## Run the admin on this computer

On Windows, double-click **`admin.cmd`**. It starts the admin and opens the review page. Keep its window open while you work, and close it to stop. Or from a terminal:

```bash
node admin/server.mjs
```

- Tinjauan survei: http://localhost:8082/admin/
- Alat dasbor: http://localhost:8082/admin/dasbor.html
- Survey app: http://localhost:8082/Survey/
- Dashboard: http://localhost:8082/Dashboard/

The server only answers on this computer. It needs Node.js 20 or later. The Alat dasbor processing also needs the Python environment in `Dashboard/.venv` (see the Dashboard README).

## Reviewing (Tinjauan survei)

1. **Ambil data**: enter the admin code (`ADMIN_CODE` in the Google Apps Script) and press **Ambil dari Google Drive**. You can also import export files from the survey app. Everything is copied to `private/`, which is never committed. Nothing in Drive is changed.
2. **Tinjau**: enter your name as reviewer, open each record, and **Setujui** or **Tolak** it. You can:
   - edit the published text;
   - correct the damage level, legal registration or reconstruction progress;
   - leave out photos.

   Warnings point out what to check. The upload itself is never changed. If a record changes after review, it goes back to **Berubah sejak ditinjau**.
3. **Terbitkan ke Dashboard**: writes the approved records into the Dashboard (see above). Refusals and houses that could not be inspected are kept for the record but are not published as points.
4. **Unggah ke GitHub**: commits and pushes.

Review decisions are kept in `private/review.json`, with earlier copies in `private/review_backup/`.

## Dashboard tools (Alat dasbor)

Map datasets, kecamatan tables and the Dashboard text, as in the original Aceh Tamiang dashboard. Source files go in `Dashboard/for claude/`. Changes are saved in `Dashboard/config/`, with old versions in `Dashboard/config/backup/`. They go online with **Unggah ke GitHub** on the review page.

The three BPBD survey layers can be renamed and described here, but not removed: they are filled by publishing on the review page.

## Folders that stay on this computer

These are git-ignored and never pushed:
- `private/`: uploads with names and NIK, review decisions, and a backup of the copied Dashboard's original git history
- `for claude/` and `Dashboard/for claude/`: source files
- `Dashboard/.venv/`: the Python environment
- `Dashboard/data/raw/`: processed source data
- `Dashboard/config/backup/`: old config versions

## Publishing the site

GitHub Pages serves `main` from the root folder. The site is https://ttrinug.github.io/pendataan-kerusakan-BPBD-tamiang/.
