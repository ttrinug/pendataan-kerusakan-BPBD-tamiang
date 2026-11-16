// Local admin server for the three parts of the project:
//   /Survey/     the surveyor app
//   /admin/      the review page (index.html) and the Dashboard tools (dasbor.html)
//   /Dashboard/  the public dashboard, which shows only published results
// and a small JSON API for both admin pages.
// Usage: node admin/server.mjs [port]   (default 8082), or double-click admin.cmd
//
// It listens on 127.0.0.1 only, so nothing is reachable from other computers. Uploads (with full
// names and NIK) and review decisions stay in private/, which is git-ignored. Publishing the
// reviewed survey writes Dashboard/data/web/bpbd_*.geojson and bpbd_photos/. The Dashboard tools
// edit Dashboard/config/ (old versions go to Dashboard/config/backup/) and process files from
// "Dashboard/for claude" with Dashboard/scripts/admin_tool.py. The GitHub button commits only
// Dashboard/data/web/ and Dashboard/config/.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.argv[2]) || 8082;
const surveyApp = join(root, 'Survey');
const dash = join(root, 'Dashboard');
const dashWeb = join(dash, 'data', 'web');
const privateDir = join(root, 'private');
const uploads = join(privateDir, 'uploads');
const reviewFile = join(privateDir, 'review.json');
const reviewBackup = join(privateDir, 'review_backup');
// Published survey results, read by the Dashboard.
const OUT_POINTS = join(dashWeb, 'bpbd_survey.geojson');
const OUT_DOCS = join(dashWeb, 'bpbd_documentation.geojson');
const OUT_RECOVERY = join(dashWeb, 'bpbd_rekonstruksi.geojson');
const OUT_PHOTOS = join(dashWeb, 'bpbd_photos');
// Photo addresses as the Dashboard page sees them.
const PHOTO_URL = 'data/web/bpbd_photos';
const EXPORT_FORMAT = 'titik-survey-export';

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};
// Only these parts of the project are served. private/, the server itself, the Dashboard's raw
// data, Python environment, source files and config backups are not.
const servable = [
  'index.html', 'Survey/', 'titik-survey/',
  'admin/index.html', 'admin/admin.js', 'admin/admin.css', 'admin/dasbor.html', 'admin/dasbor.js', 'admin/dasbor.css',
  'Dashboard/index.html', 'Dashboard/assets/', 'Dashboard/config/', 'Dashboard/data/web/', 'Dashboard/templates/'
];
const notServed = ['Dashboard/config/backup/'];
const folders = ['Survey', 'titik-survey', 'admin', 'Dashboard'];

// ------------------------------------------------------------ helpers

const hash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12);
const photoKey = (dataUrl) => hash(String(dataUrl));

// JSON with sorted keys, so the same content always gives the same key.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const isDoc = (record) => record.kind === 'documentation';

// Changes when what could be published changes; not when a record is only uploaded again.
function contentKey(record) {
  const skip = new Set(['updatedAt', 'createdAt', 'uploadedVersion', 'originals']);
  const data = Object.fromEntries(Object.entries(record).filter(([k]) => !skip.has(k)));
  data.photos = isDoc(record)
    ? record.photos.map(({ photo, original, ...rest }) => ({ ...rest, photo: photoKey(photo) }))
    : record.photos.map(photoKey);
  return hash(canonical(data));
}

async function walk(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

// Every record in private/uploads (Drive copies and imported export files). Each id keeps its
// newest version; nothing in Drive is overwritten, so older versions arrive here too.
async function readRecords() {
  const newest = new Map();
  const problems = [];
  for (const file of (await walk(uploads)).filter((f) => f.endsWith('.json'))) {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (data.format !== EXPORT_FORMAT || !Array.isArray(data.entries)) throw new Error('not an export file');
      for (const entry of data.entries) {
        if (typeof entry?.id !== 'string' || !Array.isArray(entry.photos)) continue;
        const current = newest.get(entry.id);
        if (!current || String(entry.updatedAt) > String(current.updatedAt)) newest.set(entry.id, entry);
      }
    } catch (error) {
      problems.push(`${relative(root, file)}: ${error.message}`);
    }
  }
  return { records: [...newest.values()], problems };
}

async function loadReview() {
  if (!existsSync(reviewFile)) return { records: {}, settings: { publishNames: false } };
  const data = JSON.parse(await readFile(reviewFile, 'utf8'));
  return { records: data.records ?? {}, settings: { publishNames: false, ...data.settings } };
}

async function saveReview(data) {
  await mkdir(privateDir, { recursive: true });
  if (existsSync(reviewFile)) {
    await mkdir(reviewBackup, { recursive: true });
    await copyFile(reviewFile, join(reviewBackup, `review-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  }
  await writeFile(reviewFile, `${JSON.stringify(data, null, 1)}\n`, 'utf8');
}

function stateOf(record, review) {
  const decision = review.records[record.id];
  if (!decision) return 'pending';
  if (decision.contentKey !== contentKey(record)) return 'changed';
  return decision.status;
}

// What a reviewer may change. Locations, names and NIK cannot be edited.
const SURVEY_EDITS = ['lokasi', 'dusun', 'keterangan', 'contributor', 'kerusakan', 'legalitas', 'alasanLain', 'pemulihan'];
const DOC_EDITS = ['notes', 'contributor'];
const CHOICES = { kerusakan: ['rendah', 'sedang', 'berat'], legalitas: ['ya', 'tidak', ''], pemulihan: ['0', '20', '40', '60', '80', '100'] };

// The record as it will be published: the reviewer's edits, without left-out photos.
function applyReview(record, decision) {
  const edits = decision.edits ?? {};
  const allowed = isDoc(record) ? DOC_EDITS : SURVEY_EDITS;
  const out = { ...record };
  for (const key of allowed) if (typeof edits[key] === 'string') out[key] = edits[key];
  const hidden = new Set(decision.hiddenPhotos ?? []);
  if (isDoc(record)) {
    const captions = edits.captions ?? {};
    out.photos = record.photos
      .filter((p) => !hidden.has(photoKey(p.photo)))
      .map((p) => ({ ...p, caption: captions[photoKey(p.photo)] ?? p.caption ?? '' }));
  } else {
    out.photos = record.photos.filter((p) => !hidden.has(photoKey(p)));
  }
  return out;
}

const maskNik = (nik) => (nik ? `${'•'.repeat(Math.max(0, String(nik).length - 4))}${String(nik).slice(-4)}` : '');

// Writes one resized photo (a JPEG or PNG data URL, already stripped of metadata on the device).
async function writePhoto(dataUrl, name, written) {
  const match = /^data:image\/(jpeg|png);base64,(.+)$/.exec(String(dataUrl));
  if (!match) return null;
  const file = `${name}.${match[1] === 'png' ? 'png' : 'jpg'}`;
  await writeFile(join(OUT_PHOTOS, file), Buffer.from(match[2], 'base64'));
  written.add(file);
  return `${PHOTO_URL}/${file}`;
}

const point = (properties, lon, lat) => ({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: [Number(lon.toFixed(6)), Number(lat.toFixed(6))] } });
const collection = (features) => `{"type":"FeatureCollection","features":[\n${features.map((f) => JSON.stringify(f)).join(',\n')}\n]}\n`;

async function publish() {
  const { records } = await readRecords();
  const review = await loadReview();
  const { publishNames } = review.settings;
  await mkdir(OUT_PHOTOS, { recursive: true });
  const written = new Set();
  const points = [];
  const recoveries = [];
  const docs = [];
  const log = [];
  const waiting = {};
  const notInspected = {};

  for (const record of records) {
    const state = stateOf(record, review);
    if (state !== 'approved') {
      waiting[state] = (waiting[state] ?? 0) + 1;
      continue;
    }
    const decision = review.records[record.id];
    const r = applyReview(record, decision);
    const base = record.id.replace(/[^A-Za-z0-9-]/g, '');
    if (isDoc(r)) {
      const inside = r.photos.filter((p) => p.kecamatan);
      if (inside.length < r.photos.length) log.push(`Dokumentasi ${record.id}: ${r.photos.length - inside.length} foto di luar Aceh Tamiang tidak diterbitkan.`);
      for (const [i, p] of inside.entries()) {
        const url = await writePhoto(p.photo, `${base}-${i + 1}`, written);
        if (!url) continue;
        docs.push(point({
          id: r.id, photo: i, url, caption: p.caption ?? '', takenAt: p.takenAt ?? null, desa: p.desa ?? null, kecamatan: p.kecamatan,
          contributor: r.contributor ?? '', reviewer: decision.reviewer ?? '', notes: r.notes ?? '', updatedAt: r.updatedAt
        }, p.lon, p.lat));
      }
    } else {
      if (!r.kecamatan) {
        log.push(`Titik ${record.id}: di luar Aceh Tamiang, tidak diterbitkan.`);
        continue;
      }
      // Houses not inspected (refused, or could not be inspected) are kept for the review record
      // but not published as points: a public map of refusals could cause trouble in the village.
      const status = r.pemeriksaan ?? 'diperiksa';
      if (status !== 'diperiksa') {
        notInspected[status] = (notInspected[status] ?? 0) + 1;
        continue;
      }
      const photos = [];
      for (const [i, p] of r.photos.entries()) {
        const url = await writePhoto(p, `${base}-${i + 1}`, written);
        if (url) photos.push(url);
      }
      const properties = {
        id: r.id, updatedAt: r.updatedAt, surveyedAt: r.surveyedAt ?? null, lokasi: r.lokasi ?? '',
        dusun: r.dusun ?? '', desa: r.desa ?? null, kecamatan: r.kecamatan, legalitas: r.legalitas ?? '', kerusakan: r.kerusakan ?? '',
        photos, keterangan: r.keterangan ?? '', contributor: r.contributor ?? '', reviewer: decision.reviewer ?? '',
        reviewedAt: decision.reviewedAt, accuracy_m: r.accuracy_m ? Math.round(r.accuracy_m) : null,
        // Only the last four digits of a NIK are ever published.
        nik: maskNik(r.nik)
      };
      if (publishNames) properties.nama = r.nama ?? '';
      // Reconstruction evaluations (kind "recovery") go to their own file, with the earlier
      // survey's damage level beside the progress.
      if (r.kind === 'recovery') {
        Object.assign(properties, {
          // Reconstruction progress in percent; a reviewer's edit arrives as text.
          pemulihan: r.pemulihan === '' || r.pemulihan == null ? null : Number(r.pemulihan),
          baseId: r.base?.id ?? null,
          baseSurveyedAt: r.base?.surveyedAt ?? null,
          kerusakanAwal: r.base?.kerusakan ?? ''
        });
        recoveries.push(point(properties, r.lon, r.lat));
      } else {
        points.push(point(properties, r.lon, r.lat));
      }
    }
  }

  // Photos of records that are no longer published are removed.
  let removed = 0;
  for (const file of await readdir(OUT_PHOTOS)) {
    if (!written.has(file)) {
      await rm(join(OUT_PHOTOS, file));
      removed += 1;
    }
  }
  await writeFile(OUT_POINTS, collection(points), 'utf8');
  await writeFile(OUT_DOCS, collection(docs), 'utf8');
  await writeFile(OUT_RECOVERY, collection(recoveries), 'utf8');
  return { recoveries: recoveries.length, points: points.length, photos: docs.length, removedPhotos: removed, waiting, notInspected, log, publishNames };
}

// ------------------------------------------------------------ Google Drive

const drivePath = /^(survei_kerusakan_(titik|recovery|dokumentasi)_[A-Za-z0-9_-]+\.json|originals\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+)$/;
const driveErrors = {
  'admin-code': 'Kode admin ditolak. Pastikan sama persis dengan ADMIN_CODE di Script Properties.',
  'admin-not-configured': 'Skrip Google belum punya ADMIN_CODE (atau sama dengan UPLOAD_CODE).',
  'not-configured': 'Skrip Google belum punya FOLDER_ID dan UPLOAD_CODE.',
  'not-found': 'Sebuah file hilang dari folder Drive saat diunduh.'
};

async function driveCall(body) {
  const config = JSON.parse(await readFile(join(surveyApp, 'config.json'), 'utf8'));
  if (!config.uploadUrl) throw new Error('uploadUrl belum diisi di Survey/config.json.');
  const response = await fetch(config.uploadUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body) });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`Google tidak memberi jawaban yang bisa dibaca (HTTP ${response.status}).`);
  }
  if (!data.ok) throw new Error(driveErrors[data.error] ?? `Kesalahan skrip Google: ${data.error}`);
  return data;
}

// ------------------------------------------------------------ GitHub

// The only folder this page commits. private/ is git-ignored, so it can never be pushed from here.
const publicPaths = ['Dashboard/data/web', 'Dashboard/config'];
const maxFileBytes = 50 * 1024 * 1024;

// Runs git without a shell, so a commit message cannot run anything. A text prompt for a
// password is turned off so the server never hangs; Git Credential Manager may still open a window.
function git(args, timeoutMs = 120000) {
  return new Promise((done) => {
    const child = spawn('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', (error) => { clearTimeout(timer); done({ code: -1, out, err: error.message }); });
    child.on('close', (code) => { clearTimeout(timer); done({ code, out, err }); });
  });
}

async function gitOrFail(args, timeoutMs) {
  const result = await git(args, timeoutMs);
  if (result.code !== 0) throw new Error(`git ${args[0]} gagal: ${(result.err || result.out).trim() || `exit ${result.code}`}`);
  return result.out;
}

async function gitState() {
  const branch = (await gitOrFail(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const upstream = await git(['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`]);
  const [behind, ahead] = upstream.code === 0 ? upstream.out.trim().split(/\s+/).map(Number) : [null, null];
  const out = await gitOrFail(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...publicPaths]);
  const fields = out.split('\0').filter(Boolean);
  const changes = [];
  for (let i = 0; i < fields.length; i += 1) {
    const status = fields[i].slice(0, 2);
    const path = fields[i].slice(3);
    if (status.startsWith('R')) i += 1;
    const full = join(root, path);
    changes.push({ status: status.trim(), path, size: existsSync(full) ? (await stat(full)).size : null });
  }
  return { branch, behind, ahead, changes };
}

// ------------------------------------------------------------ API

// ------------------------------------------------------------ Dashboard tools

const inbox = join(dash, 'for claude');
const python = [join(dash, '.venv/Scripts/python.exe'), join(dash, '.venv/bin/python')].find(existsSync);
const sourceTypes = ['.shp', '.gpkg', '.geojson', '.tif', '.tiff', '.xlsx'];

// Pretty-prints JSON, keeping short objects and arrays on one line so the config files stay
// readable and diffs stay small.
function pretty(value, indent = '') {
  const inline = (v) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
    const entries = Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`);
    return entries.length ? `{ ${entries.join(', ')} }` : '{}';
  };
  const flat = inline(value);
  if (value === null || typeof value !== 'object' || flat.length + indent.length <= 140) return flat;
  const inner = indent + '  ';
  if (Array.isArray(value)) return `[\n${value.map((v) => inner + pretty(v, inner)).join(',\n')}\n${indent}]`;
  return `{\n${Object.entries(value).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${pretty(v, inner)}`).join(',\n')}\n${indent}}`;
}

const configPath = (name) => join(dash, 'config', `${name}.json`);
const readConfig = async (name) => JSON.parse(await readFile(configPath(name), 'utf8'));

async function writeConfig(name, data) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await mkdir(join(dash, 'config/backup'), { recursive: true });
  await copyFile(configPath(name), join(dash, 'config/backup', `${name}-${stamp}.json`));
  await writeFile(configPath(name), pretty(data) + '\n', 'utf8');
}

// Runs Dashboard/scripts/admin_tool.py. The job fills in as it runs: progress lines in log,
// then the tool's JSON result (its last line of output) and a status of done or failed.
function runTool(args, input) {
  const job = { status: 'running', log: [], result: null };
  if (!python) {
    job.status = 'failed';
    job.result = { ok: false, error: 'Python environment not found in Dashboard/.venv. See Dashboard/README.md.' };
    job.finished = Promise.resolve(job);
    return job;
  }
  job.finished = new Promise((done) => {
    const child = spawn(python, [join(dash, 'scripts', 'admin_tool.py'), ...args], { cwd: dash });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => job.log.push(...String(chunk).split(/\r?\n/).filter(Boolean)));
    child.on('close', () => {
      try {
        job.result = JSON.parse(stdout.trim().split(/\r?\n/).pop());
      } catch {
        job.result = { ok: false, error: 'The tool gave no result; see the log.' };
      }
      job.status = job.result.ok ? 'done' : 'failed';
      done(job);
    });
    child.stdin.end(input ? JSON.stringify(input) : '');
  });
  return job;
}

// Processing can take minutes, so it runs as a job the Dashboard tools page polls.
const jobs = new Map();
let nextJob = 1;

async function listInbox(dir = inbox) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listInbox(full));
    else if (sourceTypes.includes(extname(entry.name).toLowerCase())) {
      files.push({ path: relative(inbox, full).split(sep).join('/'), size: (await stat(full)).size });
    }
  }
  return files;
}

const validId = (id) => typeof id === 'string' && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(id);

// Adds or replaces options by id in one of the cards.json lists.
function upsert(list, items) {
  for (const item of items) {
    const index = list.findIndex((o) => o.id === item.id);
    if (index >= 0) list[index] = item;
    else list.push(item);
  }
}

// The survey datasets are filled by publishing reviewed surveys, not by the Dashboard tools.
const SURVEY_DATASETS = ['bpbd-survey', 'bpbd-rekonstruksi', 'bpbd-documentation'];

const dashboardApi = {
  'GET /api/state': async () => ({
    layers: await readConfig('layers'),
    cards: await readConfig('cards'),
    text: await readConfig('text'),
    inbox: existsSync(inbox) ? await listInbox() : []
  }),

  'POST /api/inspect': async (body) => (await runTool(['inspect', body.path]).finished).result,

  'POST /api/jobs': async (body) => {
    if (!validId(body.id)) throw new Error('The dataset id must be lower-case letters, digits and hyphens.');
    const id = String(nextJob++);
    jobs.set(id, runTool(['process'], body));
    return { job: id };
  },

  // Adds or updates a dataset in layers.json, with any chart and table options in cards.json.
  'POST /api/datasets': async (body) => {
    const { dataset, chartOptions = [], tableOptions = [] } = body;
    if (!validId(dataset?.id)) throw new Error('The dataset id must be lower-case letters, digits and hyphens.');
    const layers = await readConfig('layers');
    if (!layers.groups.some((g) => g.id === dataset.group)) throw new Error(`Unknown group ${dataset.group}.`);
    const index = layers.datasets.findIndex((d) => d.id === dataset.id);
    if (index >= 0) layers.datasets[index] = { ...layers.datasets[index], ...dataset };
    else layers.datasets.push(dataset);
    await writeConfig('layers', layers);
    if (chartOptions.length || tableOptions.length) {
      const cards = await readConfig('cards');
      upsert(cards.chartOptions, chartOptions);
      upsert(cards.tableOptions, tableOptions);
      await writeConfig('cards', cards);
    }
    return { saved: dataset.id };
  },

  // Removes a dataset and its chart and table options. Its data files are left in place.
  'DELETE /api/datasets': async (body) => {
    if (SURVEY_DATASETS.includes(body.id)) throw new Error('The BPBD survey layers come from the review page and cannot be removed here.');
    const cards = await readConfig('cards');
    const usedBy = [...cards.population, ...cards.impact, ...cards.percentages, ...cards.infrastructure]
      .filter((c) => [c.dataset, c.damagedDataset, c.totalDataset].includes(body.id));
    if (usedBy.length) throw new Error(`Used by the cards ${usedBy.map((c) => c.id).join(', ')}; it cannot be removed here.`);
    const layers = await readConfig('layers');
    layers.datasets = layers.datasets.filter((d) => d.id !== body.id);
    cards.chartOptions = cards.chartOptions.filter((o) => o.dataset !== body.id);
    cards.tableOptions = cards.tableOptions.filter((o) => o.dataset !== body.id);
    await writeConfig('layers', layers);
    await writeConfig('cards', cards);
    return { removed: body.id };
  },

  'PUT /api/text': async (body) => {
    if (!body.text?.title?.id) throw new Error('The text file looks incomplete; not saved.');
    await writeConfig('text', body.text);
    return { saved: 'text' };
  }
};

// ------------------------------------------------------------ API

const api = {
  ...dashboardApi,

  'GET /api/records': async () => {
    const { records, problems } = await readRecords();
    const review = await loadReview();
    return {
      settings: review.settings,
      problems,
      records: records.map((record) => {
        const { originals, uploadedVersion, ...rest } = record;
        const shown = isDoc(record)
          ? { ...rest, photos: record.photos.map(({ original, ...p }) => ({ ...p, key: photoKey(p.photo) })) }
          : { ...rest, photos: record.photos.map((photo) => ({ photo, key: photoKey(photo) })) };
        return { record: shown, contentKey: contentKey(record), state: stateOf(record, review), review: review.records[record.id] ?? null };
      })
    };
  },

  'PUT /api/review': async (body) => {
    const { id, contentKey: key, review: decision = {} } = body;
    if (typeof id !== 'string' || !id) throw new Error('Tidak ada id.');
    const review = await loadReview();
    if (decision.status === 'pending') {
      delete review.records[id];
    } else {
      if (!['approved', 'rejected'].includes(decision.status)) throw new Error('Status tidak dikenal.');
      if (typeof key !== 'string') throw new Error('Tidak ada contentKey.');
      const reviewer = String(decision.reviewer ?? '').trim();
      if (!reviewer) throw new Error('Isi nama peninjau.');
      const edits = {};
      for (const [k, v] of Object.entries(decision.edits ?? {})) {
        if (k === 'captions' && v && typeof v === 'object') edits.captions = Object.fromEntries(Object.entries(v).map(([pk, c]) => [pk, String(c)]));
        else if ([...SURVEY_EDITS, ...DOC_EDITS].includes(k) && typeof v === 'string' && (!CHOICES[k] || CHOICES[k].includes(v))) edits[k] = v;
      }
      review.records[id] = {
        status: decision.status,
        contentKey: key,
        reviewer,
        reviewedAt: new Date().toISOString(),
        edits,
        hiddenPhotos: (decision.hiddenPhotos ?? []).map(String),
        note: String(decision.note ?? '')
      };
    }
    await saveReview(review);
    return { saved: id };
  },

  'PUT /api/settings': async (body) => {
    const review = await loadReview();
    review.settings = { ...review.settings, publishNames: Boolean(body.publishNames) };
    await saveReview(review);
    return { settings: review.settings };
  },

  // An export file chosen in the review page, saved to private/uploads/exports/.
  'POST /api/import': async (body) => {
    const data = JSON.parse(String(body.text ?? ''));
    if (data.format !== EXPORT_FORMAT || !Array.isArray(data.entries)) throw new Error(`${body.name}: bukan file ekspor dasbor ini.`);
    const name = String(body.name || 'ekspor.json').replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.json$/i, '');
    const target = join(uploads, 'exports', `${name}.json`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body.text, 'utf8');
    return { saved: relative(root, target), entries: data.entries.length };
  },

  // Copies new and changed files from the Drive upload folder. Nothing in Drive is changed.
  'POST /api/sync': async (body) => {
    const { files } = await driveCall({ adminCode: body.adminCode, action: 'list' });
    const counts = { fetched: 0, unchanged: 0, ignored: 0, total: files.length };
    for (const file of files) {
      if (!drivePath.test(file.path)) {
        counts.ignored += 1;
        continue;
      }
      const target = join(uploads, 'drive', ...file.path.split('/'));
      if (existsSync(target) && (await stat(target)).size === file.size) {
        counts.unchanged += 1;
        continue;
      }
      const { data } = await driveCall({ adminCode: body.adminCode, action: 'get', fileId: file.id });
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(data, 'base64'));
      counts.fetched += 1;
    }
    return counts;
  },

  'POST /api/publish': async () => publish(),

  'GET /api/git': async () => gitState(),

  // Commits the changes in Dashboard/data/web/ and Dashboard/config/ (only those), then pushes main to GitHub.
  'POST /api/git/push': async (body) => {
    const message = String(body.message || '').trim();
    const before = await gitState();
    if (before.branch !== 'main') throw new Error(`Salinan ini ada di cabang ${before.branch}, bukan main.`);
    const tooBig = before.changes.filter((c) => c.size > maxFileBytes);
    if (tooBig.length) throw new Error(`Terlalu besar untuk GitHub (lebih dari 50 MB): ${tooBig.map((c) => c.path).join(', ')}.`);
    let committed = null;
    if (before.changes.length) {
      if (!message) throw new Error('Tulis pesan singkat tentang perubahan ini.');
      await gitOrFail(['add', '--all', '--', ...publicPaths]);
      await gitOrFail(['commit', '-m', message, '--', ...publicPaths]);
      committed = (await gitOrFail(['log', '-1', '--format=%h %s'])).trim();
    } else if (!before.ahead) {
      return { committed: null, pushed: false, note: 'Tidak ada yang perlu diunggah: tidak ada perubahan.' };
    }
    const push = await git(['push', 'origin', 'main'], 180000);
    if (push.code !== 0) {
      const reason = (push.err || push.out).trim();
      const hint = /rejected|fetch first|non-fast-forward/.test(reason)
        ? ' GitHub punya perubahan yang lebih baru; minta Claude menggabungkannya dulu.'
        : /resolve host|unable to access|timed out/i.test(reason) ? ' Periksa koneksi internet lalu coba lagi.' : '';
      const lines = reason.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('hint:'));
      const detail = lines.find((l) => /rejected|error|fatal/i.test(l)) ?? lines.pop() ?? '';
      throw new Error(`${committed ? `Commit ${committed} dibuat, tetapi push gagal.` : 'Push gagal.'}${hint} (${detail})`);
    }
    return { committed, pushed: true, head: (await gitOrFail(['rev-parse', '--short', 'HEAD'])).trim() };
  }
};

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = decodeURIComponent(url.pathname);

  if (path.startsWith('/api/')) {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    try {
      if (req.method === 'GET' && path.startsWith('/api/jobs/')) {
        const job = jobs.get(path.slice('/api/jobs/'.length));
        return job ? send(200, { status: job.status, log: job.log, result: job.result }) : send(404, { error: 'No such job.' });
      }
      const handler = api[`${req.method} ${path}`];
      if (!handler) return send(404, { error: 'Permintaan tidak dikenal.' });
      return send(200, await handler(await readBody(req)));
    } catch (error) {
      return send(400, { error: error.message });
    }
  }

  // A folder address typed without its final slash, such as /admin, goes to the folder's page.
  if (!path.endsWith('/') && folders.includes(path.slice(1))) {
    res.writeHead(301, { Location: `${path}/${url.search}` }).end();
    return;
  }
  const file = join(root, normalize(path.endsWith('/') ? path + 'index.html' : path));
  const inside = relative(root, file).split(sep).join('/');
  const allowed = servable.some((prefix) => inside === prefix || inside.startsWith(prefix)) && !notServed.some((prefix) => inside.startsWith(prefix));
  if (!file.startsWith(root) || !allowed) {
    res.writeHead(403).end('Not served');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`Tinjauan: http://localhost:${port}/admin/   Alat dasbor: http://localhost:${port}/admin/dasbor.html`);
  console.log(`Survei: http://localhost:${port}/Survey/   Dashboard: http://localhost:${port}/Dashboard/`);
  if (!python) console.log('Catatan: Python tidak ditemukan di Dashboard/.venv; alat dataset tidak bisa memproses file.');
});
