# Survei Kerusakan Bangunan Aceh Tamiang

A dashboard for building-damage survey points and field documentation, based on the Aceh Tamiang disaster dashboard. Reviewing and publishing is described in the [main README](../README.md).

Four blocks under the title:

1. **Peta**: basemap (Jalan / Citra satelit), Tutupan lahan 2025 (ESRI), Genangan banjir teramati (Sentinel-1), Batas kecamatan, Batas desa ("Segera tersedia" until a file is added), survey points and documentation photos. Click a kecamatan, or choose one at the top right, to highlight it and zoom to it; "Semua kecamatan" goes back to the whole kabupaten. Local entries are orange, reviewed entries teal; survey points are dots, documentation is a camera icon.
2. **Data lokal**: survey points and documentation saved in this browser. Add, edit, delete, upload to Google Drive, export to a JSON file, import another device's export.
3. **Data ditinjau**: reviewed points from `data/reviewed.geojson` and reviewed documentation from `data/documentation.geojson`, read-only. The NIK is shown with only its last four digits.
4. **Ringkasan**: local and reviewed counts, by damage level and by legal registration, documentation counts, and entries per contributor (local) and per reviewer (reviewed). **Unduh Excel** saves everything in one `.xlsx` file.

## Run

From the repository folder:

```bash
node scripts/admin-server.mjs
```

Then open http://localhost:8082/titik-survey/. GPS needs `localhost` or an `https://` address, so it also works on the GitHub Pages site.

## Survey point form

1. GPS (read from the browser, can be corrected by hand)
2. Lokasi (area rumah, nama panggilan pemilik)
3. Nama lengkap
4. NIK (16 digits if filled in)
5. Dusun
6. Apakah legalitas terdaftar (Ya / Tidak)
7. Tingkat kerusakan rumah (Rendah / Sedang / Berat), required
8. Dokumentasi (photos)
9. Keterangan

Also recorded: contributor name (required), survey date, GPS accuracy, and the kecamatan, worked out from the point.

## Documentation form

As in the main dashboard: choose photos, and each one is placed on the map at the GPS position stored inside the photo. Photos without a GPS position are refused, and the same photo is not added twice. Each photo gets a caption; the entry gets the contributor's name and general notes.

Photos are shown resized to 1600 px with their metadata removed. The original file is also kept on the device and sent to Drive, because it holds the camera's GPS and time.

## Excel export

**Unduh Excel** (in Ringkasan) writes three sheets:

- **Titik survei**: one row per point, local and reviewed, with every form field, coordinates, contributor, reviewer and upload status.
- **Dokumentasi**: one row per photo, with its own location and caption.
- **Ringkasan**: the summary counts.

For local points the file has the full name and NIK, so keep it private. Reviewed points show the masked NIK. The NIK is stored as text, so Excel keeps all 16 digits.

## Unggah ke Drive: setup (once, about 10 minutes)

Use a **new** Drive folder and a **new** script, separate from the BRIN Survey one: these records hold full names and NIK.

1. **Folder.** In Google Drive, make a folder, for example `Survei Kerusakan uploads`. Open it and copy the part of the address after `/folders/`. This is the folder ID. Keep the folder private.
2. **Script.** Go to https://script.google.com, choose **New project**, and rename it `Survei Kerusakan upload`. In `Code.gs`, delete everything and paste the whole of [`drive_upload.gs`](drive_upload.gs). Save.
3. **Settings.** **Project Settings** (gear icon), then **Script Properties**, then **Add script property**:
   - `FOLDER_ID`: the folder ID
   - `UPLOAD_CODE`: a code for the field team, at least 8 characters
   - `ADMIN_CODE` (optional, for downloading uploads later): a different, long code that only the reviewer knows
4. **Publish.** Go to **Deploy → New deployment → Web app**. Set **Execute as** to `Me` and **Who has access** to `Anyone`, then deploy and authorise. Google warns that the app is unverified, which is normal for your own script: choose **Advanced → Go to … (unsafe) → Allow**. Copy the **Web app URL**, which ends in `/exec`.
5. **Check.** Open the URL in a browser. It should show `"service":"survei-kerusakan-upload"` and `"configured":true`.
6. **Connect.** Put the URL in `config.json` as `"uploadUrl"`, or send it to Claude. The URL is not secret, but the codes are: give the upload code to the field team privately, and never put either code in this repository.

**Using it:**

- **Unggah ke Drive** sends every local entry that has not been uploaded yet. The first time on each device it asks for the upload code, and the device then remembers it.
- Each entry becomes one JSON file in the folder. Original photos go to `originals/<id>/`.
- An entry that has not changed since it was uploaded is not sent again. An edited entry is sent again as a new file. Nothing in Drive is ever overwritten or deleted.
- Uploaded entries get a small green check in the Data lokal list, and the detail view shows **Diunggah ke Drive: Ya/Belum**. An entry edited after upload loses the check until it is uploaded again.
- With no signal, use **Ekspor** and upload later.

After pasting a newer `drive_upload.gs`, choose **Deploy → Manage deployments**, click the pencil, choose **New version**, then **Deploy**. The URL stays the same.

## Logos

Put the image files in `logos/` and list them in `config.json`, for example:

```json
"logos": [
  { "src": "logos/brin.png", "alt": "BRIN" },
  { "src": "logos/satgas-brin.png", "alt": "Satgas Tanggap Bencana BRIN" },
  { "src": "logos/bpbd.png", "alt": "BPBD Aceh Tamiang" }
]
```

They appear before the title, 36 px high.

## Files

- `index.html`, `app.js`, `map.js`, `excel.js`, `dom.js`, `app.css`: the page
- `config.json`: title, logos, colours, upload URL, basemaps and layers. To add village boundaries, put the GeoJSON in `data/` and set `"file"` on the `desa` layer.
- `drive_upload.gs`: the Google Apps Script for Drive upload
- `data/kecamatan.geojson`, `data/lulc_2025.png`, `data/flood_observed.geojson`: copies from `data/web/`
- `data/reviewed.geojson`, `data/documentation.geojson`: reviewed data (empty for now)

## Reviewed data format

`reviewed.geojson`: one Point per house, with the form's property names plus the reviewer:
`id, updatedAt, surveyedAt, lokasi, nik (last four digits only), nama (only if the reviewer chose to publish names), dusun, kecamatan, legalitas ("ya"/"tidak"), kerusakan ("rendah"/"sedang"/"berat"), photos (list of image URLs), keterangan, contributor, reviewer, reviewedAt, accuracy_m`

The review page writes both files; they are not edited by hand.

`documentation.geojson`: one Point per photo, as in the main dashboard:
`id, photo (0-based position in the entry), url, caption, takenAt, kecamatan, contributor, reviewer, notes, updatedAt`

A local entry leaves the Data lokal list once a reviewed entry with the same `id` and the same or a later `updatedAt` is published.

## Not done yet

- Village boundaries
- Logos (waiting for the image files)
