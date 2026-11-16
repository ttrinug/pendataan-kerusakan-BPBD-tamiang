/**
 * Survei Kerusakan Bangunan: upload receiver (Google Apps Script web app).
 *
 * The dashboard's "Unggah ke Drive" button posts here. Each survey point or documentation entry
 * is saved as one JSON file in a Drive folder, and each original photo as an image file under
 * originals/<record id>/. The script runs as the folder's owner, so contributors need no Google
 * account. Setup is in README.md, section "Unggah ke Drive".
 *
 * Use a NEW Drive folder and a NEW script deployment for this survey, separate from the BRIN
 * Survey one: these records hold full names and NIK.
 *
 * Settings are Script Properties (Project Settings > Script Properties), not code, so nothing
 * private is in this file:
 *   FOLDER_ID    the id of the Drive folder that receives uploads
 *   UPLOAD_CODE  the code every device must send; uploads without it are refused
 *   ADMIN_CODE   optional: the code a reviewer sends to list and download the uploads. It must
 *                differ from UPLOAD_CODE. Without it, these two actions are switched off.
 *
 * Requests are JSON sent as text/plain (which avoids a browser preflight request):
 *   { code, type: "original", recordId, index, name, data }   one original photo, data URL
 *   { code, type: "record", record }                          one point, reconstruction evaluation or documentation entry
 *   { code, type: "lookup", nik } or { code, type: "lookup", nama }
 *                                                             earlier surveys of a person, for a reconstruction evaluation
 *   { code, type: "photos", id }                              the photos of one earlier survey point, shown in that evaluation
 *   { adminCode, action: "list" }                             every uploaded file: id, path, size
 *   { adminCode, action: "get", fileId }                      one uploaded file, base64
 * A record file that already exists under the same name is not written again, and record files are
 * never deleted or overwritten. The search index (indeks_pencarian.json) is the one file that is
 * rewritten: it holds a short summary of each inspected point, so a lookup need not open every file.
 *
 * The photos request returns the resized photos (no originals) of the newest version of one survey
 * point, at most 6, so a surveyor can compare the house with its earlier survey.
 *
 * Lookup and privacy: a search by full NIK returns the matching surveys with that NIK. A search by
 * name returns only the last four digits of the NIK, so a name alone never reveals a NIK. At most
 * 10 results, and only for someone who has the upload code.
 */

const RECORD_ID = /^[A-Za-z0-9-]{1,64}$/;
const SERVICE = 'survei-kerusakan-upload';
const EXPORT_FORMAT = 'titik-survey-export';
const VERSION = 4;
const INDEX_NAME = 'indeks_pencarian.json';
const RECORD_FILE = /^survei_kerusakan_(titik|recovery)_.+\.json$/;
const MAX_RESULTS = 10;
const MAX_PHOTOS = 6;

// Script Properties are pasted by hand; spaces or a line break around a value are ignored.
function setting(name) {
  return String(PropertiesService.getScriptProperties().getProperty(name) || '').trim();
}

// Says whether the script is set up, never what the codes are.
function doGet() {
  const adminCode = setting('ADMIN_CODE');
  return reply({
    ok: true,
    service: SERVICE,
    version: VERSION,
    configured: Boolean(setting('UPLOAD_CODE') && setting('FOLDER_ID')),
    adminConfigured: Boolean(adminCode && adminCode !== setting('UPLOAD_CODE'))
  });
}

function doPost(e) {
  const code = setting('UPLOAD_CODE');
  const folderId = setting('FOLDER_ID');
  if (!code || !folderId) return reply({ ok: false, error: 'not-configured' });

  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return reply({ ok: false, error: 'bad-request' });
  }
  if (body && body.action) {
    const adminCode = setting('ADMIN_CODE');
    if (!adminCode || adminCode === code) return reply({ ok: false, error: 'admin-not-configured' });
    if (String(body.adminCode || '').trim() !== adminCode) return reply({ ok: false, error: 'admin-code' });
    const root = DriveApp.getFolderById(folderId);
    if (body.action === 'list') return reply({ ok: true, files: listFiles(root) });
    if (body.action === 'get') return getFile(root, String(body.fileId || ''));
    return reply({ ok: false, error: 'bad-request' });
  }
  if (!body || String(body.code || '').trim() !== code) return reply({ ok: false, error: 'code' });

  const folder = DriveApp.getFolderById(folderId);
  if (body.type === 'original') return saveOriginal(folder, body);
  if (body.type === 'record') return saveRecord(folder, body.record);
  if (body.type === 'lookup') return lookup(folder, body);
  if (body.type === 'photos') return surveyPhotos(folder, body);
  return reply({ ok: false, error: 'bad-request' });
}

function saveOriginal(folder, body) {
  const match = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/.exec(String(body.data || ''));
  if (!RECORD_ID.test(String(body.recordId)) || !Number.isInteger(body.index) || body.index < 1 || !match) {
    return reply({ ok: false, error: 'bad-request' });
  }
  const target = childFolder(childFolder(folder, 'originals'), body.recordId);
  const name = body.index + '-' + safeName(body.name);
  if (target.getFilesByName(name).hasNext()) return reply({ ok: true, name: name, existed: true });
  target.createFile(Utilities.newBlob(Utilities.base64Decode(match[2]), match[1], name));
  return reply({ ok: true, name: name });
}

function saveRecord(folder, record) {
  if (!record || !RECORD_ID.test(String(record.id)) || !Array.isArray(record.photos)) {
    return reply({ ok: false, error: 'bad-request' });
  }
  // One file per version of a record; an unchanged record sent again is skipped.
  const kind = record.kind === 'documentation' ? 'dokumentasi' : record.kind === 'recovery' ? 'recovery' : 'titik';
  const version = String(record.updatedAt || '').replace(/[^0-9A-Za-z]/g, '');
  const name = 'survei_kerusakan_' + kind + '_' + record.id + '_' + version + '.json';
  if (folder.getFilesByName(name).hasNext()) return reply({ ok: true, name: name, existed: true });
  const file = { format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), entries: [record] };
  folder.createFile(name, JSON.stringify(file), 'application/json');
  if (kind !== 'dokumentasi') {
    // The record is saved either way; a failed index update is repaired by the next rebuild.
    try {
      updateIndex(folder, [record]);
    } catch (err) {
      console.error('Index update failed: ' + err);
    }
  }
  return reply({ ok: true, name: name });
}

// ------------------------------------------------------------ search index and lookup

// The short summary of a record kept in the index.
function summary(record) {
  return {
    id: record.id,
    kind: record.kind === 'recovery' ? 'recovery' : 'survey',
    nama: String(record.nama || ''),
    nik: String(record.nik || ''),
    lokasi: String(record.lokasi || ''),
    dusun: String(record.dusun || ''),
    desa: record.desa || null,
    kecamatan: record.kecamatan || null,
    legalitas: record.legalitas || '',
    kerusakan: record.kerusakan || '',
    pemulihan: record.pemulihan == null ? '' : record.pemulihan,
    pemeriksaan: record.pemeriksaan || 'diperiksa',
    surveyedAt: record.surveyedAt || null,
    contributor: String(record.contributor || ''),
    lat: Number(record.lat),
    lon: Number(record.lon),
    updatedAt: String(record.updatedAt || '')
  };
}

function readIndex(folder) {
  const files = folder.getFilesByName(INDEX_NAME);
  if (!files.hasNext()) return null;
  const file = files.next();
  return { file: file, entries: JSON.parse(file.getBlob().getDataAsString()).entries || {} };
}

// Adds records to the index, keeping the newest version of each. A lock stops two uploads at the
// same moment from overwriting each other's changes.
function updateIndex(folder, records) {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const index = readIndex(folder) || { file: null, entries: rebuildEntries(folder) };
    for (const record of records) {
      const current = index.entries[record.id];
      if (!current || String(record.updatedAt || '') >= current.updatedAt) index.entries[record.id] = summary(record);
    }
    const text = JSON.stringify({ updatedAt: new Date().toISOString(), entries: index.entries });
    if (index.file) index.file.setContent(text);
    else folder.createFile(INDEX_NAME, text, 'application/json');
  } finally {
    lock.releaseLock();
  }
}

// Reads every point and recovery file once, for the first lookup after this version is deployed.
function rebuildEntries(folder) {
  const entries = {};
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    if (!RECORD_FILE.test(file.getName())) continue;
    try {
      for (const record of JSON.parse(file.getBlob().getDataAsString()).entries || []) {
        const current = entries[record.id];
        if (!current || String(record.updatedAt || '') >= current.updatedAt) entries[record.id] = summary(record);
      }
    } catch (err) {
      console.error('Skipped ' + file.getName() + ': ' + err);
    }
  }
  return entries;
}

const normalName = (text) => String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

// The photos of the newest version of one survey point. Record files are named
// survei_kerusakan_titik_<id>_<version>.json, and the version sorts by time.
function surveyPhotos(folder, body) {
  const id = String(body.id || '');
  if (!RECORD_ID.test(id)) return reply({ ok: false, error: 'bad-request' });
  const prefix = 'survei_kerusakan_titik_' + id + '_';
  const files = folder.searchFiles("title contains '" + prefix + "'");
  let latest = null;
  while (files.hasNext()) {
    const file = files.next();
    if (file.getName().indexOf(prefix) === 0 && (!latest || file.getName() > latest.getName())) latest = file;
  }
  if (!latest) return reply({ ok: true, photos: [] });
  const record = (JSON.parse(latest.getBlob().getDataAsString()).entries || [])[0] || {};
  const photos = (record.photos || []).filter((p) => /^data:image\/(jpeg|png);base64,/.test(p)).slice(0, MAX_PHOTOS);
  return reply({ ok: true, photos: photos });
}

function lookup(folder, body) {
  const nik = String(body.nik || '').replace(/\s/g, '');
  const words = normalName(body.nama).split(' ').filter(Boolean);
  const byNik = /^\d{16}$/.test(nik);
  if (!byNik && words.join('').length < 3) return reply({ ok: false, error: 'bad-request' });
  let index = readIndex(folder);
  if (!index) {
    updateIndex(folder, []);
    index = readIndex(folder);
  }
  const results = Object.keys(index.entries)
    .map((id) => index.entries[id])
    // Only inspected survey points: a reconstruction evaluation always starts from a survey.
    .filter((e) => e.pemeriksaan === 'diperiksa' && e.kind !== 'recovery')
    .filter((e) => (byNik ? e.nik === nik : words.every((w) => normalName(e.nama).indexOf(w) >= 0)))
    .sort((a, b) => String(b.surveyedAt).localeCompare(String(a.surveyedAt)))
    .slice(0, MAX_RESULTS)
    .map((e) => {
      const out = Object.assign({}, e);
      // A name search shows only the last four digits of the NIK.
      if (!byNik) {
        out.nikMasked = e.nik ? '••••••••••••' + e.nik.slice(-4) : '';
        out.nik = '';
      }
      return out;
    });
  return reply({ ok: true, results: results });
}

// The records in the folder, and the original photos under originals/<record id>/.
function listFiles(root) {
  const files = [];
  const add = (iterator, prefix) => {
    while (iterator.hasNext()) {
      const file = iterator.next();
      files.push({ id: file.getId(), path: prefix + file.getName(), size: file.getSize() });
    }
  };
  add(root.getFiles(), '');
  const originals = root.getFoldersByName('originals');
  if (originals.hasNext()) {
    const records = originals.next().getFolders();
    while (records.hasNext()) {
      const record = records.next();
      add(record.getFiles(), 'originals/' + record.getName() + '/');
    }
  }
  return files;
}

// Only files inside the upload folder can be read this way.
function getFile(root, fileId) {
  const match = listFiles(root).find(function (f) { return f.id === fileId; });
  if (!match) return reply({ ok: false, error: 'not-found' });
  const bytes = DriveApp.getFileById(fileId).getBlob().getBytes();
  return reply({ ok: true, path: match.path, data: Utilities.base64Encode(bytes) });
}

function childFolder(parent, name) {
  const found = parent.getFoldersByName(name);
  return found.hasNext() ? found.next() : parent.createFolder(name);
}

// File names come from the device; keep only safe characters.
function safeName(name) {
  const cleaned = String(name || 'photo').split(/[\\/]/).pop().replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.slice(-80) || 'photo';
}

function reply(value) {
  return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
