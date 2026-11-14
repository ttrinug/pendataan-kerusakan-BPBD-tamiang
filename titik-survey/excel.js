// Writes the data on this device to one Excel file. SheetJS is loaded only when needed.
const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/xlsx.mjs';

const formatDate = (value) => (value ? new Date(value).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '');

// A sheet from rows of values, with the column widths fitted to the text (up to a limit).
function sheet(XLSX, header, rows) {
  const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
  ws['!cols'] = header.map((title, i) => ({
    wch: Math.min(50, Math.max(String(title).length, ...rows.map((row) => String(row[i] ?? '').length)) + 2)
  }));
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length, c: header.length - 1 } }) };
  return ws;
}

// points and docs: entries from this device. The label functions turn stored ids into words.
export async function exportExcel({ title, points, docs, summary, statusLabel, alasanLabel, kerusakanLabel, legalitasLabel, uploadedLabel }) {
  const XLSX = await import(XLSX_URL);
  const book = XLSX.utils.book_new();

  // NIK is text, so Excel keeps all 16 digits. The signature image stays on the device; the
  // file only says whether there is one.
  const pointRows = points.map((entry) => [
    formatDate(entry.surveyedAt),
    statusLabel(entry),
    alasanLabel(entry),
    entry.kecamatan ?? 'Di luar Aceh Tamiang',
    entry.desa ?? '',
    entry.dusun ?? '',
    entry.lokasi ?? '',
    entry.nama ?? '',
    entry.nik ?? '',
    legalitasLabel(entry.legalitas),
    kerusakanLabel(entry.kerusakan),
    entry.lat,
    entry.lon,
    entry.accuracy_m ? Math.round(entry.accuracy_m) : '',
    (entry.photos ?? []).length,
    entry.keterangan ?? '',
    entry.signature?.image ? 'Ya' : 'Belum',
    entry.signature?.signer ?? '',
    entry.contributor ?? '',
    uploadedLabel(entry),
    entry.id
  ]);
  XLSX.utils.book_append_sheet(book, sheet(XLSX, [
    'Tanggal survei', 'Status pemeriksaan', 'Alasan', 'Kecamatan', 'Desa', 'Dusun', 'Lokasi', 'Nama lengkap', 'NIK',
    'Legalitas terdaftar', 'Tingkat kerusakan', 'Lintang', 'Bujur', 'Akurasi GPS (m)', 'Jumlah foto', 'Keterangan',
    'Tanda tangan pemilik', 'Penanda tangan', 'Kontributor', 'Diunggah ke Drive', 'ID'
  ], pointRows), 'Titik survei');

  // One row per documentation photo, since each photo has its own location.
  const docRows = docs.flatMap((entry) => entry.photos.map((photo, i) => [
    formatDate(photo.takenAt),
    photo.kecamatan ?? 'Di luar Aceh Tamiang',
    photo.desa ?? '',
    `${i + 1} dari ${entry.photos.length}`,
    photo.caption ?? '',
    photo.lat,
    photo.lon,
    entry.notes ?? '',
    entry.contributor ?? '',
    uploadedLabel(entry),
    entry.id
  ]));
  XLSX.utils.book_append_sheet(book, sheet(XLSX, [
    'Waktu foto', 'Kecamatan', 'Desa', 'Foto', 'Keterangan foto', 'Lintang', 'Bujur', 'Catatan', 'Kontributor', 'Diunggah ke Drive', 'ID'
  ], docRows), 'Dokumentasi');

  XLSX.utils.book_append_sheet(book, sheet(XLSX, ['Ringkasan', 'Jumlah'], summary), 'Ringkasan');

  const now = new Date();
  const stamp = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace('T', '_').replace(':', '');
  const name = `${title.replace(/[^A-Za-z0-9]+/g, '_')}_${stamp}.xlsx`;
  XLSX.writeFile(book, name, { compression: true });
  return name;
}
