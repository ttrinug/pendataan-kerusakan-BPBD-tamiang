// Local review server: the dashboard at /titik-survey/, the review page at /admin/, and a small
// JSON API for reviewing uploads before they are published.
// Usage: node scripts/admin-server.mjs [port]   (default 8082)
//
// It listens on 127.0.0.1 only, so nothing is reachable from other computers. Uploads (with full
// names and NIK) and review decisions stay in private/, which is git-ignored. Publishing writes
// only titik-survey/data/reviewed.geojson, documentation.geojson and photos/; the GitHub button
// commits only titik-survey/data/.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, extname, join, normalize, relative, resolve, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.argv[2]) || 8082;
const site = join(root, 'titik-survey');
const privateDir = join(root, 'private');
const uploads = join(privateDir, 'uploads');
const reviewFile = join(privateDir, 'review.json');
const reviewBackup = join(privateDir, 'review_backup');
const OUT_POINTS = join(site, 'data', 'reviewed.geojson');
const OUT_DOCS = join(site, 'data', 'documentation.geojson');
const OUT_PHOTOS = join(site, 'data', 'photos');
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
  '.svg': 'image/svg+xml'
};
// Only these parts of the project are served; private/ is not.
const servable = ['index.html', 'titik-survey/', 'admin/'];

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
const SURVEY_EDITS = ['lokasi', 'dusun', 'keterangan', 'contributor', 'kerusakan', 'legalitas', 'alasanLain'];
const DOC_EDITS = ['notes', 'contributor'];
const CHOICES = { kerusakan: ['rendah', 'sedang', 'berat'], legalitas: ['ya', 'tidak', ''] };

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
  return `data/photos/${file}`;
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
      points.push(point(properties, r.lon, r.lat));
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
  return { points: points.length, photos: docs.length, removedPhotos: removed, waiting, notInspected, log, publishNames };
}

// ------------------------------------------------------------ Google Drive

const drivePath = /^(survei_kerusakan_(titik|dokumentasi)_[A-Za-z0-9_-]+\.json|originals\/[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+)$/;
const driveErrors = {
  'admin-code': 'Kode admin ditolak. Pastikan sama persis dengan ADMIN_CODE di Script Properties.',
  'admin-not-configured': 'Skrip Google belum punya ADMIN_CODE (atau sama dengan UPLOAD_CODE).',
  'not-configured': 'Skrip Google belum punya FOLDER_ID dan UPLOAD_CODE.',
  'not-found': 'Sebuah file hilang dari folder Drive saat diunduh.'
};

async function driveCall(body) {
  const config = JSON.parse(await readFile(join(site, 'config.json'), 'utf8'));
  if (!config.uploadUrl) throw new Error('uploadUrl belum diisi di titik-survey/config.json.');
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
const publicPaths = ['titik-survey/data'];
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

const api = {
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

  // Commits the changes in titik-survey/data/ (only those), then pushes main to GitHub.
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
      const handler = api[`${req.method} ${path}`];
      if (!handler) return send(404, { error: 'Permintaan tidak dikenal.' });
      return send(200, await handler(await readBody(req)));
    } catch (error) {
      return send(400, { error: error.message });
    }
  }

  // A folder address typed without its final slash, such as /admin, goes to the folder's page.
  if (!path.endsWith('/') && servable.includes(`${path.slice(1)}/`)) {
    res.writeHead(301, { Location: `${path}/${url.search}` }).end();
    return;
  }
  const file = join(root, normalize(path.endsWith('/') ? path + 'index.html' : path));
  const inside = relative(root, file).split(sep).join('/');
  if (!file.startsWith(root) || !servable.some((prefix) => inside === prefix || inside.startsWith(prefix))) {
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
  console.log(`Tinjauan: http://localhost:${port}/admin/   Dasbor: http://localhost:${port}/titik-survey/`);
});
