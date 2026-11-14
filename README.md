# Pendataan Kerusakan Bangunan BPBD Aceh Tamiang

A system for assessing damaged buildings in Aceh Tamiang, in three parts:

1. **Aplikasi survei** (`titik-survey/`), for surveyors: a map and the data recorded on the device. It works without signal. Details in [titik-survey/README.md](titik-survey/README.md).
2. **Aplikasi review** (`admin/`, `scripts/admin-server.mjs`): a local page where the BPBD reviewers check uploads before anything is published.
3. **Dashboard final**: not built yet. It will show how much has been surveyed, where, and the damage picture, from the reviewed data in `titik-survey/data/`.

`index.html` sends visitors on to `titik-survey/`.

Plain HTML, CSS and JavaScript, with no build step. The review page needs Node.js 20 or later.

## Run on this computer

On Windows, double-click **`admin.cmd`**. It starts the review server and opens the review page in the browser. Keep its window open while you work, and close it to stop. If the server is already running, it only opens the page.

Or from a terminal:

```bash
node scripts/admin-server.mjs
```

- Review page: http://localhost:8082/admin/
- Dashboard: http://localhost:8082/titik-survey/

The server only answers on this computer, never from other computers on the network.

## Reviewing

1. **Ambil data**: enter the admin code (`ADMIN_CODE` in the Google Apps Script) and press **Ambil dari Google Drive**. You can also import export files from the dashboard's **Ekspor** button. Everything is copied to `private/`, which is never committed. Nothing in Drive is changed.
2. **Tinjau**: enter your name as reviewer, open each record, and **Setujui** or **Tolak** it. You can:
   - edit the text that will be published (lokasi, dusun, keterangan, kontributor, captions);
   - correct the damage level or legal registration;
   - leave out photos.

   Warnings point out what to check, for example:
   - a point outside Aceh Tamiang;
   - a NIK or the owner's full name written in the text.

   The upload itself is never changed. If a record changes after review, it goes back to **Berubah sejak ditinjau**.
3. **Terbitkan ke dasbor**: writes `titik-survey/data/reviewed.geojson`, `documentation.geojson` and `photos/` from the approved records.
   - **The NIK is never published in full**, only its last four digits.
   - Full names are published only if you tick **Terbitkan nama lengkap pemilik**. The repository is public.
4. **Unggah ke GitHub**: commits only `titik-survey/data/` and pushes it.

Review decisions are kept in `private/review.json`, with earlier copies in `private/review_backup/`.

## Publishing the site

The repository is published with GitHub Pages:

1. On GitHub, open **Settings → Pages**.
2. Under **Source**, choose **Deploy from a branch**.
3. Choose branch `main`, folder `/ (root)`, and save.

The site then runs at https://ttrinug.github.io/pendataan-kerusakan-BPBD-tamiang/titik-survey/.
