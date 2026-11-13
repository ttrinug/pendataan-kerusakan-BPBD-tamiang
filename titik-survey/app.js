// Survei Kerusakan Bangunan: a simplified clone of the Aceh Tamiang dashboard with four blocks.
//   1. Map (basemap, land cover, flood, kecamatan, village boundaries when they arrive, survey
//      points and documentation photos). A click on a kecamatan highlights it and zooms to it.
//   2. Local data: survey points and documentation saved in this browser (IndexedDB) until
//      they are uploaded to Google Drive or exported for review
//   3. Reviewed data: points and documentation a reviewer has checked, read from data/
//   4. Summary of local data (by contributor) and reviewed data (by reviewer), with an Excel export
//
// Documentation entries are photos placed on the map at the GPS position stored in each photo,
// with a caption each and general notes, as in the main dashboard.
import { el } from './dom.js';
import { createMap, cameraUrl } from './map.js';
import { exportExcel } from './excel.js';

const DB_NAME = 'titik-survey';
const STORE = 'entries';
const EXPORT_FORMAT = 'titik-survey-export';
const MAX_PHOTO_SIDE = 1600;
const EXIFR_URL = 'https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/lite.esm.mjs';
const CODE_KEY = 'titik-survey-upload-code';

const KERUSAKAN = [
  { id: 'rendah', label: 'Rendah' },
  { id: 'sedang', label: 'Sedang' },
  { id: 'berat', label: 'Berat' }
];
const LEGALITAS = [
  { id: 'ya', label: 'Ya' },
  { id: 'tidak', label: 'Tidak' }
];
const labelOf = (list, id) => list.find((o) => o.id === id)?.label ?? '—';

let config;
let boundaries = [];
let local = [];
let reviewed = [];
let reviewedDocs = [];
let mapView;

// ------------------------------------------------------------------ helpers

const formatDate = (value) => (value ? new Date(value).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

// A local date and time in the form a datetime-local input expects.
function localDateTime(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

// Only the last four digits of a NIK are shown for reviewed points.
const maskNik = (nik) => (nik ? `${'•'.repeat(Math.max(0, String(nik).length - 4))}${String(nik).slice(-4)}` : '—');

const formatSize = (bytes) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);

const isDoc = (entry) => entry.kind === 'documentation';
// Where a list row or "Ke titik" leads: a survey point, or a documentation entry's first photo.
const anchorOf = (entry) => (isDoc(entry) ? entry.photos[0] : entry);
const sortDate = (entry) => String(isDoc(entry) ? entry.photos[0]?.takenAt ?? entry.createdAt : entry.surveyedAt);

// ------------------------------------------------------------------ device storage

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, run) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = run(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(request?.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

const allLocal = () => withStore('readonly', (store) => store.getAll());
const putLocal = (entry) => withStore('readwrite', (store) => store.put(entry));
const deleteLocal = (id) => withStore('readwrite', (store) => store.delete(id));

// ------------------------------------------------------------------ photos

const readDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result);
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

// The photo file exactly as the camera gave it, metadata included. It stays on the device and
// goes only to the private Drive folder and the export file.
const originalOf = async (file) => ({ name: file.name, type: file.type, data: await readDataUrl(file) });

const dataUrlBytes = (dataUrl) => Math.round(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);

// Resizes a photo and re-encodes it as JPEG, which also drops the file's metadata.
async function photoToDataUrl(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = el('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.8);
}

// The GPS position and capture time stored in a photo, or null when it holds no usable
// position. Some cameras write 0, 0 when they have no fix; that counts as no position.
let exifr;
async function photoMetadata(file) {
  if (!exifr) {
    const module = await import(EXIFR_URL);
    exifr = module.default ?? module;
  }
  const meta = await exifr.parse(file).catch(() => null);
  const { latitude: lat, longitude: lon } = meta ?? {};
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const taken = meta.DateTimeOriginal ?? meta.CreateDate;
  return { lat, lon, takenAt: taken instanceof Date && !Number.isNaN(taken.getTime()) ? localDateTime(taken) : null };
}

// ------------------------------------------------------------------ kecamatan lookup

function ringContains(ring, [x, y]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const polygonContains = (rings, point) => ringContains(rings[0], point) && !rings.slice(1).some((hole) => ringContains(hole, point));
function featureContains(feature, point) {
  const { type, coordinates } = feature.geometry;
  if (type === 'Polygon') return polygonContains(coordinates, point);
  if (type === 'MultiPolygon') return coordinates.some((polygon) => polygonContains(polygon, point));
  return false;
}
const kecamatanAt = (lon, lat) => boundaries.find((f) => featureContains(f, [lon, lat]))?.properties.name ?? null;

// ------------------------------------------------------------------ data

// A local entry that a reviewer has published (same id, same or later version) leaves the
// Local list. If it is edited again on this device it is listed again.
function isReviewed(entry) {
  const newerOrSame = (r) => String(entry.updatedAt) <= String(r.updatedAt ?? '');
  return (isDoc(entry) ? reviewedDocs : reviewed).some((r) => r.id === entry.id && newerOrSame(r));
}
const waiting = () => local.filter((e) => !isReviewed(e));
const latestContributor = () => [...local].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]?.contributor;
const isUploaded = (entry) => entry.uploadedVersion === entry.updatedAt;

function mapData() {
  const point = (properties, lon, lat) => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: [lon, lat] } });
  const collection = (features) => ({ type: 'FeatureCollection', features });
  const pending = waiting();
  const surveys = [...reviewed.map((e) => [e, 'reviewed']), ...pending.filter((e) => !isDoc(e)).map((e) => [e, 'local'])];
  const docs = [...reviewedDocs.map((e) => [e, 'reviewed']), ...pending.filter(isDoc).map((e) => [e, 'local'])];
  return {
    points: collection(surveys.map(([e, status]) => point({ id: e.id, status }, e.lon, e.lat))),
    docs: collection(docs.flatMap(([e, status]) => e.photos.map((p, i) => point({ id: e.id, photo: i, status }, p.lon, p.lat))))
  };
}

async function refresh() {
  local = await allLocal();
  renderLists();
  renderSummary();
  const { points, docs } = mapData();
  mapView?.setData(points, docs);
}

const setStatus = (text) => { document.getElementById('local-status').textContent = text; };

// ------------------------------------------------------------------ header

function renderHeader() {
  document.title = config.title;
  document.getElementById('app-title').textContent = config.title;
  const logos = document.getElementById('logos');
  logos.replaceChildren(...config.logos.map((logo) => {
    const image = el('img');
    image.src = logo.src;
    image.alt = logo.alt ?? '';
    return image;
  }));
  logos.hidden = !config.logos.length;

  const select = document.getElementById('kecamatan-select');
  const all = el('option', null, 'Semua kecamatan');
  all.value = '';
  const names = boundaries.map((f) => f.properties).sort((a, b) => a.name.localeCompare(b.name));
  select.replaceChildren(all, ...names.map(({ code, name }) => {
    const option = el('option', null, name);
    option.value = code;
    return option;
  }));
  select.addEventListener('change', () => selectKecamatan(select.value || null));
}

// The single place the kecamatan changes, from the dropdown or a click on the map.
function selectKecamatan(code) {
  document.getElementById('kecamatan-select').value = code ?? '';
  const name = boundaries.find((f) => f.properties.code === code)?.properties.name;
  document.getElementById('title-kecamatan').textContent = name ? ` | Kecamatan ${name}` : '';
  document.title = name ? `${config.title} | Kecamatan ${name}` : config.title;
  mapView.selectKecamatan(code);
}

// ------------------------------------------------------------------ lists

function badge(kerusakan) {
  return el('span', `badge badge-${kerusakan ?? 'none'}`, labelOf(KERUSAKAN, kerusakan));
}

const UPLOADED_LABEL = 'Sudah diunggah ke Drive';

function uploadedCheck() {
  const check = el('span', 'uploaded-check');
  check.title = UPLOADED_LABEL;
  check.setAttribute('role', 'img');
  check.setAttribute('aria-label', UPLOADED_LABEL);
  check.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="8"/><path d="M4.5 8.3 7 10.7 11.5 5.6"/></svg>';
  return check;
}

function uploadedFact(entry) {
  const value = el('span', null, isUploaded(entry) ? 'Ya ' : 'Belum');
  if (isUploaded(entry)) value.append(uploadedCheck());
  const row = el('div', 'fact');
  row.append(el('dt', null, 'Diunggah ke Drive'));
  const dd = el('dd');
  dd.append(value);
  row.append(dd);
  return row;
}

function fillList(kind, entries, emptyText) {
  const list = document.getElementById(`rows-${kind}`);
  document.getElementById(`count-${kind}`).textContent = entries.length;
  if (!entries.length) {
    list.replaceChildren(el('li', 'empty', emptyText));
    return;
  }
  const newestFirst = [...entries].sort((a, b) => sortDate(b).localeCompare(sortDate(a)));
  list.replaceChildren(...newestFirst.map((entry) => {
    const row = el('button', 'point-row');
    row.type = 'button';
    const title = el('span', 'point-title');
    const anchor = anchorOf(entry);
    if (isDoc(entry)) {
      const icon = el('img', 'row-icon');
      icon.src = cameraUrl(config.colors[kind]);
      icon.alt = '';
      title.append(icon, el('span', 'point-name', `Dokumentasi · ${entry.photos.length} foto`));
      row.append(title, el('span'));
    } else {
      const dot = el('span', `dot dot-${kind}`);
      dot.setAttribute('aria-hidden', 'true');
      title.append(dot, el('span', 'point-name', entry.lokasi || entry.nama || 'Tanpa keterangan lokasi'));
      row.append(title, badge(entry.kerusakan));
    }
    // A small green check after the title once this version is in Google Drive.
    if (kind === 'local' && isUploaded(entry)) title.append(uploadedCheck());
    const dusun = !isDoc(entry) && entry.dusun ? (/^dusun\b/i.test(entry.dusun) ? entry.dusun : `Dusun ${entry.dusun}`) : null;
    const meta = [dusun, anchor.kecamatan ?? 'Di luar Aceh Tamiang', formatDate(sortDate(entry))];
    row.append(el('span', 'point-meta', meta.filter(Boolean).join(' · ')));
    row.addEventListener('click', () => (isDoc(entry) ? showDocEntry(entry, kind) : showEntry(entry, kind)));
    const goTo = el('button', 'goto', 'Ke titik');
    goTo.type = 'button';
    goTo.addEventListener('click', () => mapView.goTo(anchor.lon, anchor.lat));
    const item = el('li', 'point-item');
    item.append(row, goTo);
    return item;
  }));
}

function renderLists() {
  const pending = waiting();
  fillList('local', pending, 'Belum ada data di perangkat ini. Tekan "Tambah".');
  fillList('reviewed', [...reviewed, ...reviewedDocs], 'Belum ada data yang ditinjau.');
  document.getElementById('export-points').disabled = !pending.length;
  document.getElementById('upload-points').disabled = !pending.length;
}

// ------------------------------------------------------------------ summary

function summaryCounts() {
  const pending = waiting();
  const sets = { local: pending.filter((e) => !isDoc(e)), reviewed };
  const docSets = { local: pending.filter(isDoc), reviewed: reviewedDocs };
  return { pending, sets, docSets };
}

function renderSummary() {
  const { pending, sets, docSets } = summaryCounts();
  const body = document.getElementById('summary-body');

  const tile = (kind, label) => {
    const node = el('div', `tile tile-${kind}`);
    const photos = docSets[kind].reduce((n, e) => n + e.photos.length, 0);
    node.append(
      el('span', 'tile-label', label),
      el('span', 'tile-value', String(sets[kind].length)),
      el('span', 'tile-sub', `titik survei · ${docSets[kind].length} dokumentasi (${photos} foto)`)
    );
    return node;
  };
  const tiles = el('div', 'tiles');
  tiles.append(tile('local', 'Lokal (kontributor)'), tile('reviewed', 'Ditinjau (peninjau)'));

  // A count table: one row per option, local and reviewed side by side, with a bar.
  const table = (caption, options, key) => {
    const wrap = el('table', 'summary-table');
    wrap.append(el('caption', null, caption));
    const head = el('tr');
    head.append(el('th', null, ''), el('th', 'num', 'Lokal'), el('th', 'num', 'Ditinjau'));
    wrap.append(head);
    const count = (kind, id) => sets[kind].filter((e) => e[key] === id).length;
    const max = Math.max(1, ...options.flatMap((o) => [count('local', o.id), count('reviewed', o.id)]));
    for (const option of options) {
      const row = el('tr');
      row.append(el('th', null, option.label));
      for (const kind of ['local', 'reviewed']) {
        const n = count(kind, option.id);
        const cell = el('td', 'num');
        const bar = el('span', `bar bar-${kind}`);
        bar.style.width = `${(n / max) * 100}%`;
        bar.setAttribute('aria-hidden', 'true');
        cell.append(bar, el('span', 'bar-value', String(n)));
        row.append(cell);
      }
      wrap.append(row);
    }
    return wrap;
  };

  // People and how many entries each has: contributors for local data, reviewers for reviewed data.
  const people = (caption, kind, entries, key, empty) => {
    const box = el('div', 'people');
    box.append(el('h3', null, caption));
    const counts = peopleCounts(entries, key);
    if (!counts.length) {
      box.append(el('p', 'note', empty));
      return box;
    }
    const list = el('ul', 'people-list');
    for (const [name, n] of counts) {
      const item = el('li');
      const dot = el('span', `dot dot-${kind}`);
      dot.setAttribute('aria-hidden', 'true');
      const who = el('span', 'people-name');
      who.append(dot, name);
      item.append(who, el('span', 'people-count', String(n)));
      list.append(item);
    }
    box.append(list);
    return box;
  };

  const tables = el('div', 'tables');
  tables.append(table('Tingkat kerusakan rumah', KERUSAKAN, 'kerusakan'), table('Legalitas terdaftar', LEGALITAS, 'legalitas'));
  const peopleRow = el('div', 'people-row');
  peopleRow.append(
    people('Per kontributor (lokal)', 'local', pending, 'contributor', 'Belum ada data lokal.'),
    people('Per peninjau (ditinjau)', 'reviewed', [...reviewed, ...reviewedDocs], 'reviewer', 'Belum ada data ditinjau.')
  );
  body.replaceChildren(tiles, tables, peopleRow);
}

function peopleCounts(entries, key) {
  const counts = new Map();
  for (const entry of entries) {
    const name = (entry[key] ?? '').trim() || '(tanpa nama)';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// ------------------------------------------------------------------ Excel

async function downloadExcel() {
  const button = document.getElementById('excel-export');
  const status = document.getElementById('summary-status');
  button.disabled = true;
  status.textContent = 'Menyiapkan file Excel…';
  try {
    const { pending, sets, docSets } = summaryCounts();
    const tag = (entries, status) => entries.map((entry) => ({ entry, status }));
    const count = (kind, key, id) => sets[kind].filter((e) => e[key] === id).length;
    const photos = (kind) => docSets[kind].reduce((n, e) => n + e.photos.length, 0);
    const summary = [
      ['Titik survei', sets.local.length, sets.reviewed.length],
      ...KERUSAKAN.map((o) => [`Kerusakan: ${o.label}`, count('local', 'kerusakan', o.id), count('reviewed', 'kerusakan', o.id)]),
      ...LEGALITAS.map((o) => [`Legalitas terdaftar: ${o.label}`, count('local', 'legalitas', o.id), count('reviewed', 'legalitas', o.id)]),
      ['Dokumentasi', docSets.local.length, docSets.reviewed.length],
      ['Foto dokumentasi', photos('local'), photos('reviewed')],
      ...peopleCounts(pending, 'contributor').map(([name, n]) => [`Kontributor: ${name}`, n, '']),
      ...peopleCounts([...reviewed, ...reviewedDocs], 'reviewer').map(([name, n]) => [`Peninjau: ${name}`, '', n])
    ];
    const name = await exportExcel({
      title: config.title,
      points: [...tag(sets.local, 'Lokal'), ...tag(sets.reviewed, 'Ditinjau')],
      docs: [...tag(docSets.local, 'Lokal'), ...tag(docSets.reviewed, 'Ditinjau')],
      summary,
      nikOf: (entry, s) => (s === 'Lokal' ? entry.nik ?? '' : (entry.nik ? maskNik(entry.nik) : '')),
      kerusakanLabel: (id) => (id ? labelOf(KERUSAKAN, id) : ''),
      legalitasLabel: (id) => (id ? labelOf(LEGALITAS, id) : ''),
      uploadedLabel: (entry, s) => (s === 'Lokal' ? (isUploaded(entry) ? 'Ya' : 'Belum') : '')
    });
    status.textContent = `${name} diunduh. File ini berisi nama dan NIK; simpan dengan aman.`;
  } catch (error) {
    console.error(error);
    status.textContent = 'File Excel tidak bisa dibuat. Periksa koneksi internet lalu coba lagi.';
  } finally {
    button.disabled = false;
  }
}

// ------------------------------------------------------------------ dialog: detail

const dialog = document.getElementById('point-dialog');

function openDialog(title, content) {
  const head = el('div', 'dialog-head');
  const close = el('button', null, 'Tutup');
  close.type = 'button';
  close.addEventListener('click', () => dialog.close());
  head.append(el('h2', null, title), close);
  const body = el('div', 'dialog-body');
  body.append(...content);
  dialog.replaceChildren(head, body);
  if (!dialog.open) dialog.showModal();
}

function fact(label, value) {
  const row = el('div', 'fact');
  row.append(el('dt', null, label), el('dd', null, value));
  return row;
}

function gallery(photos, current = 0, onPick = null) {
  if (!photos?.length) return el('p', 'note', 'Tidak ada foto.');
  const wrap = el('div', 'gallery');
  const main = el('img', 'gallery-main');
  main.src = photos[current];
  main.alt = 'Dokumentasi';
  wrap.append(main);
  if (photos.length > 1) {
    const strip = el('div', 'gallery-strip');
    photos.forEach((src, i) => {
      const button = el('button');
      button.type = 'button';
      button.setAttribute('aria-label', `Foto ${i + 1}`);
      if (i === current) button.setAttribute('aria-current', 'true');
      const thumb = el('img');
      thumb.src = src;
      thumb.alt = '';
      button.append(thumb);
      button.addEventListener('click', () => (onPick ? onPick(i) : (main.src = src)));
      strip.append(button);
    });
    wrap.append(strip);
  }
  return wrap;
}

function originalsFact(originals) {
  const files = originals.filter((o) => o?.data);
  if (!files.length) return [];
  return [fact('Foto asli di perangkat', `${files.length} · ${formatSize(files.reduce((n, o) => n + dataUrlBytes(o.data), 0))}`)];
}

function localActions(onEdit, confirmText, id) {
  const actions = el('div', 'actions');
  const edit = el('button', null, 'Ubah');
  edit.type = 'button';
  edit.addEventListener('click', onEdit);
  const remove = el('button', 'danger', 'Hapus');
  remove.type = 'button';
  remove.addEventListener('click', async () => {
    if (!confirm(confirmText)) return;
    await deleteLocal(id);
    dialog.close();
    await refresh();
  });
  actions.append(edit, remove);
  return actions;
}

function showById(id, kind) {
  const entry = kind === 'reviewed' ? reviewed.find((e) => e.id === id) : waiting().find((e) => e.id === id && !isDoc(e));
  if (entry) showEntry(entry, kind);
}

function showDocById(id, index, kind) {
  const entry = kind === 'reviewed' ? reviewedDocs.find((e) => e.id === id) : waiting().find((e) => e.id === id && isDoc(e));
  if (entry) showDocEntry(entry, kind, index);
}

function showEntry(entry, kind) {
  const isLocal = kind === 'local';
  const facts = el('dl', 'facts');
  facts.append(
    fact('Status', isLocal ? 'Lokal, belum ditinjau' : 'Ditinjau'),
    fact('Lokasi', entry.lokasi || '—'),
    fact('Nama lengkap', entry.nama || '—'),
    fact('NIK', isLocal ? entry.nik || '—' : maskNik(entry.nik)),
    fact('Dusun', entry.dusun || '—'),
    fact('Kecamatan', entry.kecamatan ?? 'Di luar Aceh Tamiang'),
    fact('Legalitas terdaftar', labelOf(LEGALITAS, entry.legalitas)),
    fact('Tingkat kerusakan', labelOf(KERUSAKAN, entry.kerusakan)),
    fact('Koordinat GPS', `${entry.lat.toFixed(6)}, ${entry.lon.toFixed(6)}`)
  );
  if (entry.accuracy_m) facts.append(fact('Akurasi GPS', `± ${Math.round(entry.accuracy_m)} m`));
  facts.append(fact('Tanggal survei', formatDate(entry.surveyedAt)), fact('Kontributor', entry.contributor || '—'));
  if (isLocal) facts.append(...originalsFact(entry.originals ?? []), uploadedFact(entry));
  else facts.append(fact('Peninjau', entry.reviewer || '—'), fact('Tanggal tinjauan', formatDate(entry.reviewedAt)));

  const content = [
    gallery(entry.photos),
    facts,
    el('h3', null, 'Keterangan'),
    entry.keterangan ? el('p', 'long-text', entry.keterangan) : el('p', 'note', '—')
  ];
  if (isLocal) content.push(localActions(() => showForm(entry), 'Hapus titik ini dari perangkat? Tindakan ini tidak bisa dibatalkan.', entry.id));
  openDialog(entry.lokasi || entry.nama || 'Titik survei', content);
}

// One documentation entry, showing one photo at a time with its own location and time.
function showDocEntry(entry, kind, index = 0) {
  const isLocal = kind === 'local';
  const photo = entry.photos[index] ?? entry.photos[0];
  const facts = el('dl', 'facts');
  facts.append(
    fact('Status', isLocal ? 'Lokal, belum ditinjau' : 'Ditinjau'),
    fact('Keterangan foto', photo.caption || '—'),
    fact('Foto', `${index + 1} dari ${entry.photos.length}`),
    fact('Kecamatan', photo.kecamatan ?? 'Di luar Aceh Tamiang'),
    fact('Koordinat GPS', `${photo.lat.toFixed(6)}, ${photo.lon.toFixed(6)}`),
    fact('Waktu foto', formatDate(photo.takenAt)),
    fact('Kontributor', entry.contributor || '—')
  );
  if (isLocal) facts.append(...originalsFact(entry.photos.map((p) => p.original)), uploadedFact(entry));
  else facts.append(fact('Peninjau', entry.reviewer || '—'));

  const content = [
    gallery(entry.photos.map((p) => p.photo), index, (i) => showDocEntry(entry, kind, i)),
    facts,
    el('p', 'note', 'Lokasi dari data GPS di dalam foto, tidak diperiksa ulang.'),
    el('h3', null, 'Catatan dan temuan'),
    entry.notes ? el('p', 'long-text', entry.notes) : el('p', 'note', '—')
  ];
  if (isLocal) content.push(localActions(() => showDocForm(entry), 'Hapus dokumentasi ini dari perangkat? Tindakan ini tidak bisa dibatalkan.', entry.id));
  openDialog('Dokumentasi', content);
}

// ------------------------------------------------------------------ dialog: forms

function field(labelText, control, hint) {
  const label = el('label', 'field');
  label.append(el('span', 'field-label', labelText), control);
  if (hint) label.append(el('span', 'note', hint));
  return label;
}

function input(type, value = '') {
  const node = el('input');
  node.type = type;
  node.value = value ?? '';
  return node;
}

// A row of radio buttons; read() gives the chosen id or ''.
function choice(name, options, value) {
  const group = el('fieldset', 'choice');
  const inputs = options.map((option) => {
    const radio = input('radio', option.id);
    radio.name = name;
    radio.checked = option.id === value;
    const label = el('label', 'choice-option');
    label.append(radio, option.label);
    group.append(label);
    return radio;
  });
  group.read = () => inputs.find((r) => r.checked)?.value ?? '';
  return group;
}

function errorLine() {
  const error = el('p', 'form-error');
  error.hidden = true;
  const fail = (text) => {
    error.textContent = text;
    error.hidden = false;
    error.scrollIntoView({ block: 'nearest' });
  };
  return { error, fail };
}

// The two kinds of new record, as tabs at the top of the Add window.
function tabBar(active) {
  const bar = el('div', 'tabs');
  bar.setAttribute('role', 'tablist');
  for (const [kind, label, open] of [['survey', 'Titik survei', () => showForm()], ['doc', 'Dokumentasi', () => showDocForm()]]) {
    const button = el('button', null, label);
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(kind === active));
    if (kind !== active) button.addEventListener('click', open);
    bar.append(button);
  }
  return bar;
}

function showForm(existing = null) {
  const { error, fail } = errorLine();

  // 1. GPS from the browser; the numbers can also be corrected by hand.
  const lat = input('number', existing?.lat ?? '');
  const lon = input('number', existing?.lon ?? '');
  lat.step = lon.step = 'any';
  lat.inputMode = lon.inputMode = 'decimal';
  let accuracy = existing?.accuracy_m ?? null;
  const gpsStatus = el('span', 'note');
  const gps = el('button', 'secondary', 'Ambil lokasi GPS');
  gps.type = 'button';
  const readGps = () => {
    if (!navigator.geolocation) {
      gpsStatus.textContent = 'GPS tidak tersedia di peramban ini. Isi koordinat secara manual.';
      return;
    }
    gps.disabled = true;
    gpsStatus.textContent = 'Menunggu GPS…';
    navigator.geolocation.getCurrentPosition((position) => {
      lat.value = position.coords.latitude.toFixed(6);
      lon.value = position.coords.longitude.toFixed(6);
      accuracy = position.coords.accuracy;
      gpsStatus.textContent = `Akurasi: ± ${Math.round(accuracy)} m`;
      gps.disabled = false;
    }, () => {
      gpsStatus.textContent = 'Lokasi GPS gagal dibaca. Izinkan akses lokasi atau isi koordinat secara manual.';
      gps.disabled = false;
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
  };
  gps.addEventListener('click', readGps);
  for (const node of [lat, lon]) node.addEventListener('input', () => { accuracy = null; gpsStatus.textContent = 'Koordinat diisi manual.'; });
  const gpsRow = el('div', 'gps-row');
  gpsRow.append(gps, gpsStatus);
  const coords = el('div', 'two-col');
  coords.append(field('Lintang', lat), field('Bujur', lon));

  // 2–7. Text fields and choices.
  const lokasi = input('text', existing?.lokasi);
  lokasi.placeholder = 'mis. Rumah Bang Udin, dekat meunasah';
  const nama = input('text', existing?.nama);
  nama.autocomplete = 'off';
  const nik = input('text', existing?.nik);
  nik.inputMode = 'numeric';
  nik.maxLength = 16;
  nik.autocomplete = 'off';
  const dusun = input('text', existing?.dusun);
  const legalitas = choice('legalitas', LEGALITAS, existing?.legalitas);
  const kerusakan = choice('kerusakan', KERUSAKAN, existing?.kerusakan);

  // 8. Documentation photos: the resized copy shown, and the original file kept for Drive.
  const photos = (existing?.photos ?? []).map((photo, i) => ({ photo, original: existing.originals?.[i] ?? null }));
  const previews = el('div', 'previews');
  const drawPreviews = () => previews.replaceChildren(...photos.map(({ photo }, i) => {
    const item = el('div', 'preview');
    const image = el('img');
    image.src = photo;
    image.alt = '';
    const remove = el('button', null, '×');
    remove.type = 'button';
    remove.setAttribute('aria-label', `Hapus foto ${i + 1}`);
    remove.addEventListener('click', () => {
      photos.splice(i, 1);
      drawPreviews();
    });
    item.append(image, remove);
    return item;
  }));
  drawPreviews();
  const picker = input('file');
  picker.accept = 'image/*';
  picker.multiple = true;
  picker.addEventListener('change', async () => {
    for (const file of picker.files) {
      try {
        photos.push({ photo: await photoToDataUrl(file), original: await originalOf(file) });
      } catch {
        fail(`Foto tidak bisa dibaca: ${file.name}`);
      }
    }
    picker.value = '';
    drawPreviews();
  });

  // 9. Notes, plus who recorded the point and when.
  const keterangan = el('textarea');
  keterangan.rows = 4;
  keterangan.value = existing?.keterangan ?? '';
  const contributor = input('text', existing?.contributor ?? latestContributor() ?? '');
  const date = input('datetime-local', existing?.surveyedAt ?? localDateTime());

  const save = el('button', 'primary', 'Simpan');
  save.type = 'button';
  save.addEventListener('click', async () => {
    const latitude = Number(lat.value);
    const longitude = Number(lon.value);
    if (lat.value === '' || lon.value === '' || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return fail('Lokasi GPS belum diisi atau tidak valid.');
    const nikValue = nik.value.replace(/\s/g, '');
    if (nikValue && !/^\d{16}$/.test(nikValue)) return fail('NIK harus 16 angka.');
    if (!kerusakan.read()) return fail('Pilih tingkat kerusakan rumah.');
    if (!contributor.value.trim()) return fail('Isi nama kontributor.');
    const now = new Date().toISOString();
    const entry = {
      id: existing?.id ?? crypto.randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      surveyedAt: date.value,
      lat: latitude,
      lon: longitude,
      accuracy_m: accuracy,
      kecamatan: kecamatanAt(longitude, latitude),
      lokasi: lokasi.value.trim(),
      nama: nama.value.trim(),
      nik: nikValue,
      dusun: dusun.value.trim(),
      legalitas: legalitas.read(),
      kerusakan: kerusakan.read(),
      photos: photos.map((p) => p.photo),
      originals: photos.map((p) => p.original),
      keterangan: keterangan.value.trim(),
      contributor: contributor.value.trim()
    };
    try {
      await putLocal(entry);
    } catch {
      return fail('Titik tidak bisa disimpan. Penyimpanan perangkat mungkin penuh atau diblokir.');
    }
    await refresh();
    setStatus('Titik disimpan di perangkat ini.');
    showById(entry.id, 'local');
  });

  openDialog(existing ? 'Ubah titik' : 'Tambah', [
    ...(existing ? [] : [tabBar('survey')]),
    el('h3', null, '1. GPS'), gpsRow, coords,
    field('2. Lokasi', lokasi, 'Area rumah, nama panggilan pemilik.'),
    field('3. Nama lengkap', nama),
    field('4. NIK', nik, '16 angka. Hanya tersimpan di perangkat, file ekspor dan folder Drive.'),
    field('5. Dusun', dusun),
    field('6. Apakah legalitas terdaftar?', legalitas),
    field('7. Tingkat kerusakan rumah', kerusakan),
    el('h3', null, '8. Dokumentasi'), field('Tambah foto', picker), previews,
    field('9. Keterangan', keterangan),
    el('div', 'divider'),
    field('Nama kontributor', contributor, 'Nama Anda, untuk ringkasan per kontributor.'),
    field('Tanggal survei', date),
    error, save
  ]);
  if (!existing) readGps();
}

// Documentation: photos placed by their own GPS metadata, a caption each, and general notes.
function showDocForm(existing = null) {
  const { error, fail } = errorLine();
  const contributor = input('text', existing?.contributor ?? latestContributor() ?? '');
  const photos = (existing?.photos ?? []).map((p) => ({ ...p }));
  const previews = el('div', 'doc-previews');
  const drawPreviews = () => previews.replaceChildren(...photos.map((p, i) => {
    const item = el('div', 'doc-preview');
    const image = el('img');
    image.src = p.photo;
    image.alt = '';
    const info = el('div', 'doc-preview-info');
    const where = el('span', 'note', `${p.kecamatan ?? 'Di luar Aceh Tamiang'} · ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} · ${formatDate(p.takenAt)}`);
    const caption = input('text', p.caption ?? '');
    caption.placeholder = 'Keterangan foto';
    caption.setAttribute('aria-label', `Keterangan foto ${i + 1}`);
    caption.addEventListener('input', () => { p.caption = caption.value; });
    const remove = el('button', 'secondary', 'Hapus foto');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      photos.splice(i, 1);
      drawPreviews();
    });
    info.append(where, caption, remove);
    item.append(image, info);
    return item;
  }));
  drawPreviews();

  // The same photo (same place and time) is not added twice, here or in another entry.
  const signature = (p) => `${p.takenAt}|${p.lat.toFixed(6)}|${p.lon.toFixed(6)}`;
  const readStatus = el('p', 'note');
  const picker = input('file');
  picker.accept = 'image/*';
  picker.multiple = true;
  picker.addEventListener('change', async () => {
    const problems = [];
    readStatus.textContent = 'Membaca foto…';
    for (const file of picker.files) {
      let meta;
      try {
        meta = await photoMetadata(file);
      } catch {
        problems.push(`Foto tidak bisa dibaca: ${file.name}.`);
        continue;
      }
      if (!meta) {
        problems.push(`${file.name}: tidak ada lokasi GPS di dalam foto.`);
        continue;
      }
      const others = local.filter((e) => isDoc(e) && e.id !== existing?.id).flatMap((e) => e.photos);
      if ([...photos, ...others].some((p) => signature(p) === signature(meta))) {
        problems.push(`${file.name}: foto ini sudah ada.`);
        continue;
      }
      try {
        photos.push({ photo: await photoToDataUrl(file), original: await originalOf(file), caption: '', ...meta, kecamatan: kecamatanAt(meta.lon, meta.lat) });
      } catch {
        problems.push(`Foto tidak bisa dibaca: ${file.name}.`);
      }
      drawPreviews();
    }
    picker.value = '';
    readStatus.textContent = problems.join(' ');
  });

  const notes = el('textarea');
  notes.rows = 4;
  notes.value = existing?.notes ?? '';

  const save = el('button', 'primary', 'Simpan');
  save.type = 'button';
  save.addEventListener('click', async () => {
    if (!photos.length) return fail('Tambahkan minimal satu foto yang berlokasi.');
    if (!contributor.value.trim()) return fail('Isi nama kontributor.');
    const now = new Date().toISOString();
    const entry = {
      kind: 'documentation',
      id: existing?.id ?? crypto.randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      contributor: contributor.value.trim(),
      notes: notes.value.trim(),
      photos: photos.map(({ photo, original, caption, lat, lon, takenAt, kecamatan }) => ({ photo, original, caption: (caption ?? '').trim(), lat, lon, takenAt, kecamatan }))
    };
    try {
      await putLocal(entry);
    } catch {
      return fail('Dokumentasi tidak bisa disimpan. Penyimpanan perangkat mungkin penuh atau diblokir.');
    }
    await refresh();
    setStatus('Dokumentasi disimpan di perangkat ini.');
    showDocById(entry.id, 0, 'local');
  });

  openDialog(existing ? 'Ubah dokumentasi' : 'Tambah', [
    ...(existing ? [] : [tabBar('doc')]),
    field('Nama kontributor', contributor, 'Nama Anda, untuk ringkasan per kontributor.'),
    el('h3', null, 'Foto'),
    field('Pilih foto', picker, 'Lokasi dan waktu dibaca dari data GPS di dalam setiap foto. Foto tanpa lokasi tidak dapat dipakai, jadi aktifkan lokasi di aplikasi kamera.'),
    readStatus,
    previews,
    el('h3', null, 'Catatan dan temuan'),
    field('Catatan umum untuk foto-foto ini.', notes),
    error, save
  ]);
}

// ------------------------------------------------------------------ upload to Google Drive
//
// Records go to the project's Google Apps Script (drive_upload.gs in this folder), which saves
// them in the coordinator's Drive folder. Each original photo is sent on its own and the record
// without their data, so no single request is large. The upload code is asked once per device.

const readCode = () => {
  try {
    return localStorage.getItem(CODE_KEY) || '';
  } catch {
    return '';
  }
};
const keepCode = (code) => {
  try {
    if (code) localStorage.setItem(CODE_KEY, code);
    else localStorage.removeItem(CODE_KEY);
  } catch {
    // Without storage the code is simply asked again next time.
  }
};

// The same file name rule as the Apps Script, so the record can say where its originals are.
const safeName = (name) => String(name || 'photo').split(/[\\/]/).pop().replace(/[^A-Za-z0-9._-]/g, '_').slice(-80) || 'photo';

function uploadParts(entry) {
  const originals = isDoc(entry) ? entry.photos.map((p) => p.original ?? null) : entry.originals ?? [];
  const files = originals.map((o, i) => (o?.data ? { index: i + 1, name: o.name, data: o.data } : null)).filter(Boolean);
  const pointer = (o, i) => (o ? { name: o.name, type: o.type, file: o.file ?? `originals/${entry.id}/${i + 1}-${safeName(o.name)}` } : null);
  const { uploadedVersion, ...rest } = entry;
  const record = isDoc(entry)
    ? { ...rest, photos: entry.photos.map((p, i) => ({ ...p, original: pointer(p.original, i) })) }
    : { ...rest, originals: originals.map(pointer) };
  return { files, record };
}

async function post(body) {
  // text/plain keeps this a simple request, which Apps Script accepts from another site.
  const response = await fetch(config.uploadUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const result = await response.json();
  if (!result.ok) throw Object.assign(new Error(result.error), { reason: result.error });
  return result;
}

async function uploadToDrive() {
  if (!config.uploadUrl) return setStatus('Unggah ke Drive belum disiapkan. Gunakan Ekspor untuk sementara.');
  const pending = waiting().filter((e) => !isUploaded(e));
  if (!pending.length) return setStatus('Semua data lokal sudah diunggah.');
  const code = readCode() || (prompt('Masukkan kode unggah (tanyakan kepada koordinator):') ?? '').trim();
  if (!code) return undefined;
  const button = document.getElementById('upload-points');
  button.disabled = true;
  let done = 0;
  try {
    for (const [i, entry] of pending.entries()) {
      setStatus(`Mengunggah ${i + 1} dari ${pending.length}…`);
      const { files, record } = uploadParts(entry);
      for (const file of files) await post({ code, type: 'original', recordId: entry.id, ...file });
      await post({ code, type: 'record', record });
      await putLocal({ ...entry, uploadedVersion: entry.updatedAt });
      keepCode(code);
      done += 1;
    }
    setStatus(`${done} data terunggah ke Drive.`);
  } catch (error) {
    if (error.reason === 'code') {
      keepCode('');
      setStatus('Kode unggah salah. Tekan Unggah lagi untuk memasukkan kode.');
    } else {
      setStatus(`${done} data terunggah, lalu gagal (${error.message}). Periksa sinyal dan coba lagi; data yang sudah terunggah tidak dikirim ulang. Ekspor tetap bisa dipakai.`);
    }
  } finally {
    await refresh();
  }
  return undefined;
}

// ------------------------------------------------------------------ export and import

function exportFile() {
  const entries = waiting();
  const stamp = localDateTime().replace('T', '_').replace(':', '');
  const blob = new Blob([JSON.stringify({ format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), entries })], { type: 'application/json' });
  const link = el('a');
  link.href = URL.createObjectURL(blob);
  link.download = `survei_kerusakan_${stamp}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  setStatus(`${entries.length} data diekspor (${formatSize(blob.size)}). Kirim file ini ke peninjau.`);
}

const imageData = (value) => /^data:image\/(jpeg|png);base64,/.test(value);
const validOriginal = (o) => o == null || /^data:/.test(o.data) || typeof o.file === 'string';
const validDoc = (e) => Array.isArray(e.photos) && e.photos.length > 0
  && e.photos.every((p) => imageData(p?.photo) && Number.isFinite(p.lat) && Number.isFinite(p.lon) && validOriginal(p.original));
const validSurvey = (e) => Number.isFinite(e.lat) && Number.isFinite(e.lon) && Array.isArray(e.photos) && e.photos.every(imageData)
  && (e.originals === undefined || (Array.isArray(e.originals) && e.originals.every(validOriginal)));
const validEntry = (e) => typeof e?.id === 'string' && (isDoc(e) ? validDoc(e) : validSurvey(e));

// Adds entries from another device's export. Where both have the same entry, the newer edit wins.
async function importFile(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.format !== EXPORT_FORMAT || !Array.isArray(data.entries) || !data.entries.every(validEntry)) throw new Error('format');
    let added = 0;
    for (const entry of data.entries) {
      const current = local.find((e) => e.id === entry.id);
      if (current && String(current.updatedAt) >= String(entry.updatedAt)) continue;
      await putLocal(entry);
      added += 1;
    }
    await refresh();
    setStatus(`${added} data diimpor.`);
  } catch {
    setStatus('File tidak bisa diimpor. Pilih file ekspor dari dasbor ini.');
  }
}

// ------------------------------------------------------------------ start

async function loadReviewed() {
  const load = async (path) => {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) throw new Error(String(response.status));
    return response.json();
  };
  const problems = [];
  try {
    const data = await load(config.reviewedFile);
    reviewed = data.features.map((f) => ({ ...f.properties, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));
  } catch {
    problems.push('titik survei');
  }
  try {
    // Published documentation has one feature per photo; photo is its position in the entry.
    const data = await load(config.documentationFile);
    const groups = new Map();
    for (const feature of data.features) {
      const p = feature.properties;
      if (!groups.has(p.id)) groups.set(p.id, { kind: 'documentation', id: p.id, contributor: p.contributor, reviewer: p.reviewer, notes: p.notes, updatedAt: p.updatedAt, photos: [] });
      groups.get(p.id).photos[p.photo] = {
        photo: p.url, caption: p.caption, takenAt: p.takenAt, kecamatan: p.kecamatan,
        lon: feature.geometry.coordinates[0], lat: feature.geometry.coordinates[1]
      };
    }
    reviewedDocs = [...groups.values()].map((e) => ({ ...e, photos: e.photos.filter(Boolean) }));
  } catch {
    problems.push('dokumentasi');
  }
  if (problems.length) document.getElementById('reviewed-status').textContent = `Data ditinjau (${problems.join(', ')}) belum bisa dimuat.`;
}

async function init() {
  config = await (await fetch('config.json')).json();
  await loadReviewed();
  mapView = await createMap({
    config,
    onPointClick: showById,
    onDocClick: (id, index, status) => showDocById(id, index, status),
    onKecamatanClick: selectKecamatan
  });
  boundaries = mapView.boundaries;
  renderHeader();

  document.getElementById('add-point').addEventListener('click', () => showForm());
  document.getElementById('upload-points').addEventListener('click', uploadToDrive);
  document.getElementById('export-points').addEventListener('click', exportFile);
  document.getElementById('excel-export').addEventListener('click', downloadExcel);
  const picker = document.getElementById('import-points');
  picker.addEventListener('change', async () => {
    if (picker.files[0]) await importFile(picker.files[0]);
    picker.value = '';
  });

  try {
    navigator.storage?.persist?.();
    await refresh();
  } catch (error) {
    console.error(error);
    renderLists();
    renderSummary();
    setStatus('Penyimpanan perangkat tidak tersedia di peramban ini, jadi data baru tidak bisa disimpan.');
    document.getElementById('add-point').disabled = true;
  }
}

init().catch((error) => {
  console.error(error);
  document.body.textContent = 'Dasbor gagal dimuat. Muat ulang halaman.';
});
