// Survei Kerusakan Bangunan, the surveyor app: a map and a column of the data recorded on this
// device. Reviewed data and summaries belong to the review page and the final dashboard.
//   - Map: basemap, land cover, flood, kecamatan, village boundaries when they arrive, and the
//     points and documentation photos on this device. A click on a kecamatan zooms to it.
//   - Data lokal: survey points and documentation saved in this browser (IndexedDB) until they
//     are uploaded to Google Drive. Each point records whether the house was inspected, the
//     owner refused, or it could not be inspected.
//
// The app works without signal once it has been opened online (sw.js). Entries are uploaded
// by themselves when the signal comes back, once the upload code was entered on this device.
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
// Whether the house could be inspected. Only an inspected house gets the owner's details,
// damage level and signature; the other two record only where, why and who visited.
const PEMERIKSAAN = [
  { id: 'diperiksa', label: 'Diperiksa' },
  { id: 'menolak', label: 'Menolak disurvei' },
  { id: 'tidak-dapat', label: 'Tidak dapat diperiksa' }
];
const ALASAN = [
  { id: 'kosong', label: 'Rumah kosong / pemilik tidak ada' },
  { id: 'akses', label: 'Akses tidak bisa dilalui' },
  { id: 'berbahaya', label: 'Berbahaya untuk diperiksa' },
  { id: 'hancur', label: 'Bangunan hancur atau hanyut' },
  { id: 'lain', label: 'Lainnya' }
];
const labelOf = (list, id) => list.find((o) => o.id === id)?.label ?? '—';
// Points recorded before the status existed were all inspected.
const statusOf = (entry) => entry.pemeriksaan ?? 'diperiksa';

let config;
let boundaries = [];
let local = [];
let mapView;

// ------------------------------------------------------------------ helpers

const formatDate = (value) => (value ? new Date(value).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '—');

// A local date and time in the form a datetime-local input expects.
function localDateTime(date = new Date()) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

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

const latestContributor = () => [...local].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]?.contributor;
const isUploaded = (entry) => entry.uploadedVersion === entry.updatedAt;

function mapData() {
  const point = (properties, lon, lat) => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: [lon, lat] } });
  const collection = (features) => ({ type: 'FeatureCollection', features });
  return {
    points: collection(local.filter((e) => !isDoc(e)).map((e) => point({ id: e.id, status: statusOf(e) }, e.lon, e.lat))),
    docs: collection(local.filter(isDoc).flatMap((e) => e.photos.map((p, i) => point({ id: e.id, photo: i, status: 'local' }, p.lon, p.lat))))
  };
}

async function refresh() {
  local = await allLocal();
  renderLists();
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

// The badge on a list row: the damage level of an inspected house, or why it was not inspected.
function badge(entry) {
  const status = statusOf(entry);
  if (status === 'menolak') return el('span', 'badge badge-menolak', 'Menolak');
  if (status === 'tidak-dapat') return el('span', 'badge badge-tidak-dapat', 'Tidak dapat diperiksa');
  return el('span', `badge badge-${entry.kerusakan ?? 'none'}`, labelOf(KERUSAKAN, entry.kerusakan));
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

function renderLists() {
  const list = document.getElementById('rows-local');
  document.getElementById('count-local').textContent = local.length;
  const waitingUpload = local.filter((e) => !isUploaded(e)).length;
  document.getElementById('count-waiting').textContent = waitingUpload ? `${waitingUpload} belum diunggah` : local.length ? 'semua sudah diunggah' : '';
  document.getElementById('export-points').disabled = !local.length;
  document.getElementById('excel-export').disabled = !local.length;
  document.getElementById('upload-points').disabled = !waitingUpload;
  document.getElementById('clear-uploaded').disabled = !local.some(isUploaded);
  if (!local.length) {
    list.replaceChildren(el('li', 'empty', 'Belum ada data di perangkat ini. Tekan "Tambah".'));
    return;
  }
  const newestFirst = [...local].sort((a, b) => sortDate(b).localeCompare(sortDate(a)));
  list.replaceChildren(...newestFirst.map((entry) => {
    const row = el('button', 'point-row');
    row.type = 'button';
    const title = el('span', 'point-title');
    const anchor = anchorOf(entry);
    if (isDoc(entry)) {
      const icon = el('img', 'row-icon');
      icon.src = cameraUrl(config.colors.local);
      icon.alt = '';
      title.append(icon, el('span', 'point-name', `Dokumentasi · ${entry.photos.length} foto`));
      row.append(title, el('span'));
    } else {
      const dot = el('span', `dot dot-${statusOf(entry)}`);
      dot.setAttribute('aria-hidden', 'true');
      title.append(dot, el('span', 'point-name', entry.lokasi || entry.nama || 'Tanpa keterangan lokasi'));
      row.append(title, badge(entry));
    }
    // A small green check after the title once this version is in Google Drive.
    if (isUploaded(entry)) title.append(uploadedCheck());
    const dusun = !isDoc(entry) && entry.dusun ? (/^dusun\b/i.test(entry.dusun) ? entry.dusun : `Dusun ${entry.dusun}`) : null;
    const meta = [dusun, anchor.kecamatan ?? 'Di luar Aceh Tamiang', formatDate(sortDate(entry))];
    row.append(el('span', 'point-meta', meta.filter(Boolean).join(' · ')));
    row.addEventListener('click', () => (isDoc(entry) ? showDocEntry(entry) : showEntry(entry)));
    const goTo = el('button', 'goto', 'Ke titik');
    goTo.type = 'button';
    goTo.addEventListener('click', () => mapView.goTo(anchor.lon, anchor.lat));
    const item = el('li', 'point-item');
    item.append(row, goTo);
    return item;
  }));
}

// "Hapus data lokal": frees the device by removing entries whose current version is already in
// Google Drive, with their photos, original files and signatures. Entries not uploaded yet, or
// edited after their upload, are kept. The offline map is kept too, since the next survey needs it.
async function clearUploaded() {
  closeMenu();
  const uploaded = local.filter(isUploaded);
  if (!uploaded.length) return setStatus('Tidak ada data terunggah yang bisa dihapus.');
  const kept = local.length - uploaded.length;
  const bytes = uploaded.reduce((n, e) => n + JSON.stringify(e).length, 0);
  const question = [
    `Hapus ${uploaded.length} data yang sudah diunggah ke Drive dari perangkat ini (sekitar ${formatSize(bytes)})?`,
    kept ? `${kept} data yang belum diunggah tetap disimpan.` : '',
    'Data di Google Drive tidak terhapus.'
  ].filter(Boolean).join('\n\n');
  if (!confirm(question)) return undefined;
  try {
    for (const entry of uploaded) await deleteLocal(entry.id);
    setStatus(`${uploaded.length} data terunggah dihapus dari perangkat ini.${kept ? ` ${kept} data belum diunggah tetap disimpan.` : ''}`);
  } catch {
    setStatus('Sebagian data tidak bisa dihapus. Muat ulang halaman lalu coba lagi.');
  }
  await refresh();
  return undefined;
}

// ------------------------------------------------------------------ Excel

function peopleCounts(entries, key) {
  const counts = new Map();
  for (const entry of entries) {
    const name = (entry[key] ?? '').trim() || '(tanpa nama)';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// The data on this device as an Excel file. It holds names, NIK and signature status, so it is
// for the coordinator, not for sharing.
async function downloadExcel() {
  closeMenu();
  const button = document.getElementById('excel-export');
  button.disabled = true;
  setStatus('Menyiapkan file Excel…');
  try {
    const points = local.filter((e) => !isDoc(e));
    const docs = local.filter(isDoc);
    const count = (test) => points.filter(test).length;
    const summary = [
      ['Titik survei', points.length],
      ...PEMERIKSAAN.map((o) => [`Status: ${o.label}`, count((e) => statusOf(e) === o.id)]),
      ...KERUSAKAN.map((o) => [`Kerusakan: ${o.label}`, count((e) => statusOf(e) === 'diperiksa' && e.kerusakan === o.id)]),
      ...LEGALITAS.map((o) => [`Legalitas terdaftar: ${o.label}`, count((e) => statusOf(e) === 'diperiksa' && e.legalitas === o.id)]),
      ['Dengan tanda tangan pemilik', count((e) => Boolean(e.signature?.image))],
      ['Dokumentasi', docs.length],
      ['Foto dokumentasi', docs.reduce((n, e) => n + e.photos.length, 0)],
      ['Sudah diunggah ke Drive', local.filter(isUploaded).length],
      ...peopleCounts(local, 'contributor').map(([name, n]) => [`Kontributor: ${name}`, n])
    ];
    const name = await exportExcel({
      title: config.title,
      points,
      docs,
      summary,
      statusLabel: (entry) => labelOf(PEMERIKSAAN, statusOf(entry)),
      alasanLabel: (entry) => (entry.alasan ? `${labelOf(ALASAN, entry.alasan)}${entry.alasanLain ? `: ${entry.alasanLain}` : ''}` : ''),
      kerusakanLabel: (id) => (id ? labelOf(KERUSAKAN, id) : ''),
      legalitasLabel: (id) => (id ? labelOf(LEGALITAS, id) : ''),
      uploadedLabel: (entry) => (isUploaded(entry) ? 'Ya' : 'Belum')
    });
    setStatus(`${name} diunduh. File ini berisi nama dan NIK; simpan dengan aman.`);
  } catch (error) {
    console.error(error);
    setStatus('File Excel tidak bisa dibuat. Fitur ini perlu internet saat pertama kali dipakai.');
  } finally {
    button.disabled = !local.length;
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

function showById(id) {
  const entry = local.find((e) => e.id === id && !isDoc(e));
  if (entry) showEntry(entry);
}

function showDocById(id, index) {
  const entry = local.find((e) => e.id === id && isDoc(e));
  if (entry) showDocEntry(entry, index);
}

function showEntry(entry) {
  const status = statusOf(entry);
  const inspected = status === 'diperiksa';
  const facts = el('dl', 'facts');
  facts.append(fact('Status pemeriksaan', labelOf(PEMERIKSAAN, status)));
  if (status === 'tidak-dapat') facts.append(fact('Alasan', `${labelOf(ALASAN, entry.alasan)}${entry.alasanLain ? `: ${entry.alasanLain}` : ''}`));
  facts.append(fact('Lokasi', entry.lokasi || '—'));
  if (inspected) facts.append(fact('Nama lengkap', entry.nama || '—'), fact('NIK', entry.nik || '—'));
  facts.append(fact('Dusun', entry.dusun || '—'), fact('Kecamatan', entry.kecamatan ?? 'Di luar Aceh Tamiang'));
  if (inspected) facts.append(fact('Legalitas terdaftar', labelOf(LEGALITAS, entry.legalitas)), fact('Tingkat kerusakan', labelOf(KERUSAKAN, entry.kerusakan)));
  facts.append(fact('Koordinat GPS', `${entry.lat.toFixed(6)}, ${entry.lon.toFixed(6)}`));
  if (entry.accuracy_m) facts.append(fact('Akurasi GPS', `± ${Math.round(entry.accuracy_m)} m`));
  facts.append(fact('Tanggal survei', formatDate(entry.surveyedAt)), fact('Kontributor', entry.contributor || '—'));
  facts.append(...originalsFact(entry.originals ?? []), uploadedFact(entry));

  const content = [
    gallery(entry.photos),
    facts,
    el('h3', null, 'Keterangan'),
    entry.keterangan ? el('p', 'long-text', entry.keterangan) : el('p', 'note', '—')
  ];
  // The signature exists only on the device, in Drive and on the review page; it is never published.
  if (inspected) {
    content.push(el('h3', null, 'Tanda tangan pemilik rumah'));
    if (entry.signature?.image) {
      const image = el('img', 'signature-image');
      image.src = entry.signature.image;
      image.alt = `Tanda tangan ${entry.signature.signer || ''}`.trim();
      content.push(image, el('p', 'note', `${entry.signature.signer || '—'} · ${formatDate(entry.signature.signedAt)}`));
    } else {
      content.push(el('p', 'note', 'Belum ada tanda tangan.'));
    }
  }
  content.push(localActions(() => showForm(entry), 'Hapus titik ini dari perangkat? Tindakan ini tidak bisa dibatalkan.', entry.id));
  openDialog(entry.lokasi || entry.nama || 'Titik survei', content);
}

// One documentation entry, showing one photo at a time with its own location and time.
function showDocEntry(entry, index = 0) {
  const photo = entry.photos[index] ?? entry.photos[0];
  const facts = el('dl', 'facts');
  facts.append(
    fact('Keterangan foto', photo.caption || '—'),
    fact('Foto', `${index + 1} dari ${entry.photos.length}`),
    fact('Kecamatan', photo.kecamatan ?? 'Di luar Aceh Tamiang'),
    fact('Koordinat GPS', `${photo.lat.toFixed(6)}, ${photo.lon.toFixed(6)}`),
    fact('Waktu foto', formatDate(photo.takenAt)),
    fact('Kontributor', entry.contributor || '—'),
    ...originalsFact(entry.photos.map((p) => p.original)),
    uploadedFact(entry)
  );

  const content = [
    gallery(entry.photos.map((p) => p.photo), index, (i) => showDocEntry(entry, i)),
    facts,
    el('p', 'note', 'Lokasi dari data GPS di dalam foto, tidak diperiksa ulang.'),
    el('h3', null, 'Catatan dan temuan'),
    entry.notes ? el('p', 'long-text', entry.notes) : el('p', 'note', '—'),
    localActions(() => showDocForm(entry), 'Hapus dokumentasi ini dari perangkat? Tindakan ini tidak bisa dibatalkan.', entry.id)
  ];
  openDialog('Dokumentasi', content);
}

// ------------------------------------------------------------------ dialog: forms

function field(labelText, control, hint) {
  // A group of radio buttons has its own labels; wrapping it in another <label> would make a tap
  // on any option select the first one, so a group gets a plain container and a legend.
  const group = control.tagName === 'FIELDSET';
  const label = el(group ? 'div' : 'label', 'field');
  if (group) control.prepend(el('legend', 'visually-hidden', labelText));
  label.append(el('span', 'field-label', labelText), control);
  if (group) label.firstChild.setAttribute('aria-hidden', 'true');
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

// A box to sign in with a finger, stylus or mouse. image() gives a PNG data URL; an existing
// signature is shown until it is cleared and signed again.
function signaturePad(existingImage = null) {
  const wrap = el('div', 'signature');
  const canvas = el('canvas', 'signature-canvas');
  canvas.setAttribute('aria-label', 'Kotak tanda tangan');
  canvas.setAttribute('role', 'img');
  const clear = el('button', 'secondary', 'Hapus tanda tangan');
  clear.type = 'button';
  const hint = el('span', 'note', 'Tanda tangan di dalam kotak.');
  const row = el('div', 'gps-row');
  row.append(clear, hint);
  wrap.append(canvas, row);

  let drawn = false;
  let changed = false;
  let current = existingImage;
  const ctx = canvas.getContext('2d');

  // A fixed drawing surface (5:2, like the box's CSS shape). Each touch point is converted from
  // screen position to this surface, so strokes land under the finger at any screen size.
  canvas.width = 1000;
  canvas.height = 400;
  ctx.lineWidth = 5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#111827';
  if (current) {
    const image = new Image();
    image.onload = () => ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    image.src = current;
  }

  let last = null;
  const at = (event) => {
    const box = canvas.getBoundingClientRect();
    return [(event.clientX - box.left) * (canvas.width / box.width), (event.clientY - box.top) * (canvas.height / box.height)];
  };
  canvas.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    last = at(event);
    ctx.beginPath();
    ctx.arc(last[0], last[1], 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#111827';
    ctx.fill();
    drawn = true;
    changed = true;
  });
  canvas.addEventListener('pointermove', (event) => {
    if (!last) return;
    const next = at(event);
    ctx.beginPath();
    ctx.moveTo(...last);
    ctx.lineTo(...next);
    ctx.stroke();
    last = next;
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) canvas.addEventListener(type, () => { last = null; });
  clear.addEventListener('click', () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawn = false;
    changed = true;
    current = null;
  });

  return {
    node: wrap,
    isEmpty: () => !drawn && !current,
    changed: () => changed,
    // A white background so the signature reads well in any viewer.
    image: () => {
      if (!changed && current) return current;
      const out = el('canvas');
      out.width = canvas.width;
      out.height = canvas.height;
      const o = out.getContext('2d');
      o.fillStyle = '#ffffff';
      o.fillRect(0, 0, out.width, out.height);
      o.drawImage(canvas, 0, 0);
      return out.toDataURL('image/png');
    }
  };
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

  // 10. The owner's consent and signature (optional). The signer defaults to the owner's name.
  const pad = signaturePad(existing?.signature?.image);
  const signer = input('text', existing?.signature?.signer ?? '');
  signer.placeholder = 'Sama dengan nama lengkap jika kosong';
  signer.autocomplete = 'off';

  // Whether the house was inspected. The form shows only what applies to the chosen status.
  const pemeriksaan = choice('pemeriksaan', PEMERIKSAAN, existing ? statusOf(existing) : 'diperiksa');
  const alasan = el('select');
  alasan.append(el('option', null, '— Pilih alasan —'), ...ALASAN.map((o) => {
    const option = el('option', null, o.label);
    option.value = o.id;
    return option;
  }));
  alasan.firstChild.value = '';
  alasan.value = existing?.alasan ?? '';
  const alasanLain = input('text', existing?.alasanLain);
  alasanLain.placeholder = 'Jelaskan alasannya';
  const alasanLainField = field('Alasan lainnya', alasanLain);
  alasan.addEventListener('change', () => { alasanLainField.hidden = alasan.value !== 'lain'; });
  alasanLainField.hidden = alasan.value !== 'lain';

  const save = el('button', 'primary', 'Simpan');
  save.type = 'button';
  save.addEventListener('click', async () => {
    const status = pemeriksaan.read();
    const inspected = status === 'diperiksa';
    const latitude = Number(lat.value);
    const longitude = Number(lon.value);
    if (lat.value === '' || lon.value === '' || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return fail('Lokasi GPS belum diisi atau tidak valid.');
    const nikValue = inspected ? nik.value.replace(/\s/g, '') : '';
    if (nikValue && !/^\d{16}$/.test(nikValue)) return fail('NIK harus 16 angka.');
    if (inspected && !kerusakan.read()) return fail('Pilih tingkat kerusakan rumah.');
    if (status === 'tidak-dapat' && !alasan.value) return fail('Pilih alasan rumah tidak dapat diperiksa.');
    if (status === 'tidak-dapat' && alasan.value === 'lain' && !alasanLain.value.trim()) return fail('Jelaskan alasan lainnya.');
    if (!contributor.value.trim()) return fail('Isi nama kontributor.');
    // A refusal keeps no photos, and only an inspected house keeps the owner's details.
    const kept = status === 'menolak' ? [] : photos;
    const now = new Date().toISOString();
    const entry = {
      id: existing?.id ?? crypto.randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      surveyedAt: date.value,
      pemeriksaan: status,
      alasan: status === 'tidak-dapat' ? alasan.value : '',
      alasanLain: status === 'tidak-dapat' && alasan.value === 'lain' ? alasanLain.value.trim() : '',
      lat: latitude,
      lon: longitude,
      accuracy_m: accuracy,
      kecamatan: kecamatanAt(longitude, latitude),
      lokasi: lokasi.value.trim(),
      nama: inspected ? nama.value.trim() : '',
      nik: nikValue,
      dusun: dusun.value.trim(),
      legalitas: inspected ? legalitas.read() : '',
      kerusakan: inspected ? kerusakan.read() : '',
      photos: kept.map((p) => p.photo),
      originals: kept.map((p) => p.original),
      keterangan: keterangan.value.trim(),
      contributor: contributor.value.trim(),
      signature: !inspected || pad.isEmpty() ? null : {
        image: pad.image(),
        signer: signer.value.trim() || nama.value.trim(),
        // A signature carried over unchanged keeps its original time.
        signedAt: pad.changed() ? new Date().toISOString() : existing?.signature?.signedAt ?? new Date().toISOString(),
        consentText: config.consentText
      }
    };
    try {
      await putLocal(entry);
    } catch {
      return fail('Titik tidak bisa disimpan. Penyimpanan perangkat mungkin penuh atau diblokir.');
    }
    await refresh();
    setStatus('Titik disimpan di perangkat ini.');
    showById(entry.id);
    autoUpload();
  });

  // Parts shown only for some statuses: [node, statuses it belongs to].
  const section = (statuses, ...nodes) => {
    const wrap = el('div', 'form-section');
    wrap.append(...nodes);
    wrap.dataset.for = statuses.join(' ');
    return wrap;
  };
  const sections = [
    section(['tidak-dapat'], field('Alasan tidak dapat diperiksa', alasan), alasanLainField),
    section(['diperiksa'],
      field('Nama lengkap', nama),
      field('NIK', nik, '16 angka. Hanya tersimpan di perangkat, file ekspor dan folder Drive.')),
    section(['diperiksa'],
      field('Apakah legalitas terdaftar?', legalitas),
      field('Tingkat kerusakan rumah', kerusakan)),
    section(['diperiksa', 'tidak-dapat'], el('h3', null, 'Dokumentasi'), field('Tambah foto', picker), previews),
    section(['menolak'], el('p', 'note', 'Pemilik menolak: tidak ada foto, nama, NIK atau tanda tangan yang dicatat. Catat lokasi dan keterangan saja.')),
    section(['diperiksa'],
      el('h3', null, 'Persetujuan dan tanda tangan pemilik rumah'),
      el('p', 'consent-text', config.consentText),
      pad.node,
      field('Nama penanda tangan', signer, 'Isi jika yang menandatangani bukan pemilik, mis. anggota keluarga.'))
  ];
  const showSections = () => {
    const status = pemeriksaan.read();
    for (const node of sections) node.hidden = !node.dataset.for.split(' ').includes(status);
  };
  pemeriksaan.addEventListener('change', showSections);
  showSections();

  openDialog(existing ? 'Ubah titik' : 'Tambah', [
    ...(existing ? [] : [tabBar('survey')]),
    field('Status pemeriksaan', pemeriksaan),
    sections[0],
    el('h3', null, 'GPS'), gpsRow, coords,
    field('Lokasi', lokasi, 'Area rumah, nama panggilan pemilik.'),
    sections[1],
    field('Dusun', dusun),
    sections[2], sections[3], sections[4],
    field('Keterangan', keterangan),
    sections[5],
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
    showDocById(entry.id, 0);
    autoUpload();
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

// Uploads every entry not yet in Drive. A press of the button asks for the code if this device
// has none. Automatic runs (when the signal returns, after a save, every few minutes) stay quiet
// when there is no code, no signal or nothing to send. Only one run happens at a time.
let uploading = false;

async function uploadToDrive({ automatic = false } = {}) {
  if (uploading) return undefined;
  if (!config.uploadUrl) return automatic ? undefined : setStatus('Unggah ke Drive belum disiapkan. Gunakan Ekspor untuk sementara.');
  const pending = local.filter((e) => !isUploaded(e));
  if (!pending.length) return automatic ? undefined : setStatus('Semua data lokal sudah diunggah.');
  if (!navigator.onLine) return automatic ? undefined : setStatus('Tidak ada sinyal. Data tetap tersimpan dan akan diunggah otomatis saat sinyal kembali.');
  const code = readCode() || (automatic ? '' : (prompt('Masukkan kode unggah (tanyakan kepada koordinator):') ?? '').trim());
  if (!code) return undefined;
  uploading = true;
  const button = document.getElementById('upload-points');
  button.disabled = true;
  let done = 0;
  try {
    for (const [i, entry] of pending.entries()) {
      setStatus(`${automatic ? 'Mengunggah otomatis' : 'Mengunggah'} ${i + 1} dari ${pending.length}…`);
      const { files, record } = uploadParts(entry);
      for (const file of files) await post({ code, type: 'original', recordId: entry.id, ...file });
      await post({ code, type: 'record', record });
      // Saved as uploaded only if it was not edited meanwhile.
      const current = (await allLocal()).find((e) => e.id === entry.id);
      if (current?.updatedAt === entry.updatedAt) await putLocal({ ...current, uploadedVersion: entry.updatedAt });
      keepCode(code);
      done += 1;
    }
    setStatus(`${done} data terunggah ke Drive.`);
  } catch (error) {
    if (error.reason === 'code') {
      keepCode('');
      setStatus('Kode unggah salah. Tekan Unggah ke Drive untuk memasukkan kode lagi.');
    } else {
      setStatus(`${done} data terunggah, lalu terputus (${error.message}). Sisanya dicoba lagi otomatis saat sinyal kembali.`);
    }
  } finally {
    uploading = false;
    await refresh();
  }
  return undefined;
}

const autoUpload = () => uploadToDrive({ automatic: true }).catch((error) => console.error(error));

// ------------------------------------------------------------------ export and import

function exportFile() {
  closeMenu();
  const stamp = localDateTime().replace('T', '_').replace(':', '');
  const blob = new Blob([JSON.stringify({ format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), entries: local })], { type: 'application/json' });
  const link = el('a');
  link.href = URL.createObjectURL(blob);
  link.download = `survei_kerusakan_${stamp}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  setStatus(`${local.length} data diekspor (${formatSize(blob.size)}). Kirim file ini ke peninjau.`);
}

const imageData = (value) => /^data:image\/(jpeg|png);base64,/.test(value);
const validOriginal = (o) => o == null || /^data:/.test(o.data) || typeof o.file === 'string';
const validDoc = (e) => Array.isArray(e.photos) && e.photos.length > 0
  && e.photos.every((p) => imageData(p?.photo) && Number.isFinite(p.lat) && Number.isFinite(p.lon) && validOriginal(p.original));
const validSurvey = (e) => Number.isFinite(e.lat) && Number.isFinite(e.lon) && Array.isArray(e.photos) && e.photos.every(imageData)
  && (e.originals === undefined || (Array.isArray(e.originals) && e.originals.every(validOriginal)))
  && (e.signature == null || /^data:image\/png;base64,/.test(e.signature.image))
  && (e.pemeriksaan === undefined || PEMERIKSAAN.some((o) => o.id === e.pemeriksaan));
const validEntry = (e) => typeof e?.id === 'string' && (isDoc(e) ? validDoc(e) : validSurvey(e));

// Adds entries from another device's export. Where both have the same entry, the newer edit wins.
async function importFile(file) {
  closeMenu();
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

// ------------------------------------------------------------------ the "Lainnya" menu

function closeMenu() {
  const menu = document.getElementById('more-menu');
  if (menu) menu.open = false;
}

// ------------------------------------------------------------------ working without signal

// The app itself, the data layers and the libraries are kept by sw.js, so the page opens with
// no signal once it has been opened online. The street map is kept too, for the places viewed
// online; "Simpan peta offline" downloads it for all of Aceh Tamiang in one go.
function setupOffline() {
  const badgeNode = document.getElementById('network-status');
  const show = () => {
    const online = navigator.onLine;
    badgeNode.textContent = online ? 'Online' : 'Offline: data tetap tersimpan di perangkat';
    badgeNode.classList.toggle('offline', !online);
  };
  window.addEventListener('online', () => {
    show();
    autoUpload();
  });
  window.addEventListener('offline', show);
  show();
  // Retries now and then, in case the signal came back without an "online" event.
  setInterval(() => { if (document.visibilityState === 'visible') autoUpload(); }, 5 * 60 * 1000);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((error) => console.error('Offline mode unavailable', error));
  }
  document.getElementById('save-offline-map').addEventListener('click', saveOfflineMap);
}

// The street map tiles for the kabupaten, zoom 6 to 14 (closer zooms reuse level 14), plus
// its fonts and icons. About 1,100 small files; best done on Wi-Fi before going to the field.
async function saveOfflineMap() {
  closeMenu();
  if (!navigator.onLine) return setStatus('Perlu sinyal untuk menyimpan peta offline.');
  if (!('serviceWorker' in navigator) || !navigator.serviceWorker.controller) {
    return setStatus('Mode offline belum aktif. Muat ulang halaman sekali, lalu coba lagi.');
  }
  const street = config.basemaps.find((b) => b.type === 'style');
  const button = document.getElementById('save-offline-map');
  button.disabled = true;
  try {
    setStatus('Menyiapkan peta offline…');
    const style = await (await fetch(street.style)).json();
    const urls = new Set();
    for (const source of Object.values(style.sources)) {
      if (source.type !== 'vector' || !source.url) continue;
      const tilejson = await (await fetch(source.url)).json();
      const [west, south, east, north] = config.bounds;
      const maxzoom = Math.min(tilejson.maxzoom ?? 14, 14);
      for (let z = 6; z <= maxzoom; z += 1) {
        const n = 2 ** z;
        const x = (lon) => Math.floor(((lon + 180) / 360) * n);
        const y = (lat) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
        for (let tx = x(west); tx <= x(east); tx += 1) {
          for (let ty = y(north); ty <= y(south); ty += 1) {
            urls.add(tilejson.tiles[0].replace('{z}', z).replace('{x}', tx).replace('{y}', ty));
          }
        }
      }
    }
    // Map labels and icons.
    const fonts = new Set(style.layers.flatMap((l) => l.layout?.['text-font'] ?? []).filter((f) => typeof f === 'string'));
    for (const font of fonts) {
      for (const range of ['0-255', '256-511', '8192-8447']) urls.add(style.glyphs.replace('{fontstack}', encodeURIComponent(font)).replace('{range}', range));
    }
    if (typeof style.sprite === 'string') {
      for (const suffix of ['.json', '.png', '@2x.json', '@2x.png']) urls.add(style.sprite + suffix);
    }
    const list = [...urls];
    let done = 0;
    let failed = 0;
    const worker = async () => {
      while (list.length) {
        const url = list.pop();
        try {
          const response = await fetch(url);
          if (!response.ok) failed += 1;
        } catch {
          failed += 1;
        }
        done += 1;
        if (done % 25 === 0) setStatus(`Menyimpan peta offline: ${done} dari ${urls.size}…`);
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    setStatus(failed
      ? `Peta offline tersimpan sebagian (${urls.size - failed} dari ${urls.size}). Coba lagi dengan sinyal yang lebih baik.`
      : `Peta offline tersimpan (${urls.size} file). Peta jalan bisa dipakai tanpa sinyal.`);
  } catch (error) {
    console.error(error);
    setStatus('Peta offline gagal disimpan. Periksa sinyal lalu coba lagi.');
  } finally {
    button.disabled = false;
  }
  return undefined;
}

// ------------------------------------------------------------------ start

async function init() {
  config = await (await fetch('config.json')).json();
  mapView = await createMap({
    config,
    onPointClick: (id) => showById(id),
    onDocClick: (id, index) => showDocById(id, index),
    onKecamatanClick: selectKecamatan
  });
  boundaries = mapView.boundaries;
  renderHeader();

  document.getElementById('add-point').addEventListener('click', () => showForm());
  document.getElementById('clear-uploaded').addEventListener('click', clearUploaded);
  document.getElementById('upload-points').addEventListener('click', () => uploadToDrive());
  document.getElementById('export-points').addEventListener('click', exportFile);
  document.getElementById('excel-export').addEventListener('click', downloadExcel);
  const picker = document.getElementById('import-points');
  picker.addEventListener('change', async () => {
    if (picker.files[0]) await importFile(picker.files[0]);
    picker.value = '';
  });
  // A click outside the "Lainnya" menu closes it.
  document.addEventListener('click', (event) => { if (!event.target.closest('#more-menu')) closeMenu(); });
  setupOffline();

  try {
    navigator.storage?.persist?.();
    await refresh();
    autoUpload();
  } catch (error) {
    console.error(error);
    renderLists();
    setStatus('Penyimpanan perangkat tidak tersedia di peramban ini, jadi data baru tidak bisa disimpan.');
    document.getElementById('add-point').disabled = true;
  }
}

init().catch((error) => {
  console.error(error);
  document.body.textContent = 'Aplikasi gagal dimuat. Muat ulang halaman.';
});
