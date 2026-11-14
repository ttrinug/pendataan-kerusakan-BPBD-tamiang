# Survei Kerusakan Bangunan Aceh Tamiang: aplikasi surveyor

The first of the three apps: the one surveyors use in the field. Reviewing and publishing are in the review page, described in the [main README](../README.md). Summaries and reviewed data will be in the final dashboard.

Two blocks under the title:

1. **Peta**: basemap (Jalan / Citra satelit), Tutupan lahan 2025 (ESRI), Genangan banjir teramati (Sentinel-1), Batas kecamatan, Batas desa (dashed lines from zoom 10, names from zoom 12), and the entries on this device.
   - Click a kecamatan, or choose one at the top right, to highlight it and zoom to it. "Semua kecamatan" goes back to the whole kabupaten.
   - Inspected houses are orange dots, refusals grey dots, houses that could not be inspected white dots with a grey ring. Documentation is a camera icon.
2. **Data survei**: everything recorded on this device, newest first, with a green check once it is in Google Drive.
   - **Tambah** and **Unggah ke Drive** are always at hand.
   - **Lainnya** holds: Simpan peta offline, Ekspor and Impor (.json), Unduh Excel and Hapus data lokal.

## Working without signal

- **Opening:** once the app has been opened online, it opens without signal too. The app, the data layers and the libraries are stored on the device.
- **Recording:** entries are saved on the device as usual.
- **Uploading:** entries go up by themselves when the signal comes back, if the upload code was entered on this device before. The app also retries every 5 minutes. The badge at the top says **Online** or **Offline**.
- **Map:** the street map is stored for the places viewed online. **Lainnya → Simpan peta offline** stores it for all of Aceh Tamiang at once: about 1,100 files, roughly 15 MB. Do this on Wi-Fi before going to the field. Satellite imagery is only stored for the places viewed.
- **Installing:** on a phone, the browser's menu offers **Add to Home screen** or **Install**. The app then opens like an ordinary app.

## Run

From the repository folder:

```bash
node scripts/admin-server.mjs
```

Then open http://localhost:8082/titik-survey/. GPS needs `localhost` or an `https://` address, so it also works on the GitHub Pages site.

## Survey point form

**Status pemeriksaan** comes first, and the form shows only what applies:

| | Diperiksa | Menolak disurvei | Tidak dapat diperiksa |
|---|---|---|---|
| GPS, lokasi, dusun, keterangan | ✓ | ✓ | ✓ |
| Alasan (list, plus text for "Lainnya") | | | ✓ required |
| Photos | ✓ | no photos | ✓ |
| Nama lengkap, NIK, legalitas | ✓ | | |
| Tingkat kerusakan | ✓ required | | |
| Consent and owner's signature | ✓ | | |

The reasons for "Tidak dapat diperiksa" are:
- Rumah kosong / pemilik tidak ada
- Akses tidak bisa dilalui
- Berbahaya untuk diperiksa
- Bangunan hancur atau hanyut
- Lainnya

A refusal keeps no photos, name, NIK or signature. Changing a point's status removes the fields that no longer apply when it is saved.

Also recorded for every point: contributor name (required), survey date, GPS accuracy, and the desa and kecamatan, worked out from the point. Under the coordinates, the form says which desa and kecamatan the point is in, or warns that it is outside Aceh Tamiang, so the surveyor can check the GPS reading.

## Village boundaries

`data/desa.geojson` holds the 216 desa of Aceh Tamiang from BIG's Batas Desa/Kelurahan 2026, built by `scripts/build_desa.py` from `for claude/Tamkd.shp`.
- 211 boundaries are indicative ("Batas Indikatif") and 5 agreed ("Hasil Kesepakatan"). Three desa are kampung persiapan.
- The polygons cover all 12 kecamatan, but about 14% of Tenggulun has no desa polygon. Points there get a kecamatan but no desa.
- Boundaries are simplified by about 5 m to keep the file small (0.5 MB).

**Signature:**
- The consent statement comes from `config.json` (`consentText`).
- The owner signs in a box with a finger or stylus.
- The signer's name defaults to the owner's name.
- It is saved as a small image, with the signer, the time and the exact statement shown.
- It goes to Drive and the review page, but never to the published files.
- Editing a point keeps its signature and signing time, unless the signature is cleared and signed again.

## Hapus data lokal

**Lainnya → Hapus data lokal** frees space on the device. It removes every entry whose current version is already in Google Drive, with its photos, original files and signature. The offline map is kept for the next survey.

- Entries not uploaded yet, or edited after their upload, are kept.
- It asks first, and says how many entries it will remove.
- Nothing in Drive is deleted.

## Documentation form

As in the main dashboard: choose photos, and each one is placed on the map at the GPS position stored inside the photo. Photos without a GPS position are refused, and the same photo is not added twice. Each photo gets a caption; the entry gets the contributor's name and general notes.

Photos are shown resized to 1600 px with their metadata removed. The original file is also kept on the device and sent to Drive, because it holds the camera's GPS and time.

## Excel export

**Lainnya → Unduh Excel** writes the data on this device to three sheets:

- **Titik survei**: one row per point, with its status, reason, every form field, coordinates, whether it has a signature, contributor and upload status.
- **Dokumentasi**: one row per photo, with its own location and caption.
- **Ringkasan**: counts by status, damage level and legal registration, and per contributor.

The file has full names and NIK, so keep it private. The NIK is stored as text, so Excel keeps all 16 digits. Excel export needs internet the first time it is used on a device.

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
- With no signal, entries wait on the device and go up by themselves when the signal returns. **Ekspor** still works as a backup.

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

- `index.html`, `app.js`, `map.js`, `excel.js`, `dom.js`, `app.css`: the app
- `sw.js`: the service worker that keeps the app working without signal. Raise `APP_VERSION` when the list of app files changes.
- `manifest.webmanifest`, `icons/`: for installing the app on a phone
- `config.json`: title, logos, consent statement, colours, upload URL, basemaps and layers.
- `drive_upload.gs`: the Google Apps Script for Drive upload
- `data/kecamatan.geojson`, `data/desa.geojson`, `data/lulc_2025.png`, `data/flood_observed.geojson`: map layers
- `data/reviewed.geojson`, `data/documentation.geojson`: reviewed data written by the review page, for the final dashboard

## Reviewed data format

`reviewed.geojson`: one Point per house, with the form's property names plus the reviewer:
`id, updatedAt, surveyedAt, lokasi, nik (last four digits only), nama (only if the reviewer chose to publish names), dusun, desa, kecamatan, legalitas ("ya"/"tidak"), kerusakan ("rendah"/"sedang"/"berat"), photos (list of image URLs), keterangan, contributor, reviewer, reviewedAt, accuracy_m`

The review page writes both files; they are not edited by hand.

`documentation.geojson`: one Point per photo, as in the main dashboard:
`id, photo (0-based position in the entry), url, caption, takenAt, kecamatan, contributor, reviewer, notes, updatedAt`

Only inspected houses are published as points. Refusals and houses that could not be inspected stay in the review record and the Excel file, but are not shown as points on a public map.

## Not done yet

- Logos (waiting for the image files)
