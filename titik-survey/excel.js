// Writes the local and reviewed data to one Excel file. SheetJS is loaded only when needed.
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

// points and docs: [{ entry, status }] where status is "Lokal" or "Ditinjau".
// nikOf(entry, status) decides how a NIK appears; labelOf turns stored ids into labels.
export async function exportExcel({ title, points, docs, summary, nikOf, kerusakanLabel, legalitasLabel, uploadedLabel }) {
  const XLSX = await import(XLSX_URL);
  const book = XLSX.utils.book_new();

  // NIK and coordinates stay text or numbers as given; NIK is text so Excel keeps all 16 digits.
  const pointRows = points.map(({ entry, status }) => [
    status,
    formatDate(entry.surveyedAt),
    entry.kecamatan ?? 'Di luar Aceh Tamiang',
    entry.dusun ?? '',
    entry.lokasi ?? '',
    entry.nama ?? '',
    nikOf(entry, status),
    legalitasLabel(entry.legalitas),
    kerusakanLabel(entry.kerusakan),
    entry.lat,
    entry.lon,
    entry.accuracy_m ? Math.round(entry.accuracy_m) : '',
    (entry.photos ?? []).length,
    entry.keterangan ?? '',
    entry.contributor ?? '',
    entry.reviewer ?? '',
    formatDate(entry.reviewedAt),
    uploadedLabel(entry, status),
    entry.id
  ]);
  XLSX.utils.book_append_sheet(book, sheet(XLSX, [
    'Status', 'Tanggal survei', 'Kecamatan', 'Dusun', 'Lokasi', 'Nama lengkap', 'NIK', 'Legalitas terdaftar',
    'Tingkat kerusakan', 'Lintang', 'Bujur', 'Akurasi GPS (m)', 'Jumlah foto', 'Keterangan', 'Kontributor',
    'Peninjau', 'Tanggal tinjauan', 'Diunggah ke Drive', 'ID'
  ], pointRows), 'Titik survei');

  // One row per documentation photo, since each photo has its own location.
  const docRows = docs.flatMap(({ entry, status }) => entry.photos.map((photo, i) => [
    status,
    formatDate(photo.takenAt),
    photo.kecamatan ?? 'Di luar Aceh Tamiang',
    `${i + 1} dari ${entry.photos.length}`,
    photo.caption ?? '',
    photo.lat,
    photo.lon,
    entry.notes ?? '',
    entry.contributor ?? '',
    entry.reviewer ?? '',
    uploadedLabel(entry, status),
    entry.id
  ]));
  XLSX.utils.book_append_sheet(book, sheet(XLSX, [
    'Status', 'Waktu foto', 'Kecamatan', 'Foto', 'Keterangan foto', 'Lintang', 'Bujur', 'Catatan', 'Kontributor',
    'Peninjau', 'Diunggah ke Drive', 'ID'
  ], docRows), 'Dokumentasi');

  XLSX.utils.book_append_sheet(book, sheet(XLSX, ['Ringkasan', 'Lokal', 'Ditinjau'], summary), 'Ringkasan');

  const now = new Date();
  const stamp = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16).replace('T', '_').replace(':', '');
  const name = `${title.replace(/[^A-Za-z0-9]+/g, '_')}_${stamp}.xlsx`;
  XLSX.writeFile(book, name, { compression: true });
  return name;
}
