// Review page: gets uploads (from Google Drive or export files), lets a reviewer approve or
// reject each record with small edits, publishes the approved ones to the dashboard and pushes
// them to GitHub. All file work happens in scripts/admin-server.mjs.

const STATES = {
  pending: 'Perlu ditinjau',
  changed: 'Berubah sejak ditinjau',
  approved: 'Disetujui',
  rejected: 'Ditolak'
};
const FILTERS = [
  ['review', 'Perlu ditinjau', (s) => s === 'pending' || s === 'changed'],
  ['approved', 'Disetujui', (s) => s === 'approved'],
  ['rejected', 'Ditolak', (s) => s === 'rejected'],
  ['all', 'Semua', () => true]
];
const KERUSAKAN = [['rendah', 'Rendah'], ['sedang', 'Sedang'], ['berat', 'Berat']];
const LEGALITAS = [['', '—'], ['ya', 'Ya'], ['tidak', 'Tidak']];
const PEMULIHAN = [['belum', 'Belum diperbaiki'], ['proses', 'Sedang diperbaiki'], ['selesai', 'Selesai diperbaiki'], ['pindah', 'Pindah / relokasi']];
const labelIn = (list, id) => list.find(([value]) => value === id)?.[1] ?? '—';
const CODE_KEY = 'survei-kerusakan-admin-code';
const REVIEWER_KEY = 'survei-kerusakan-reviewer';

let items = [];
let filter = 'review';
let loaded = false;

// ------------------------------------------------------------ helpers

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'text') node.textContent = value;
    else if (key === 'class') node.className = value;
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) if (child != null) node.append(child);
  return node;
}

async function api(method, path, body) {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function showMessage(text, isError = false) {
  const node = document.getElementById('message');
  node.textContent = text;
  node.classList.toggle('error', isError);
  node.hidden = !text;
  if (text) node.scrollIntoView({ block: 'nearest' });
}

const store = {
  get: (key) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } },
  set: (key, value) => { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* not remembered */ } }
};

const formatDate = (value) => (value ? new Date(value).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const isDoc = (record) => record.kind === 'documentation';
const dateOf = (record) => (isDoc(record) ? record.photos[0]?.takenAt : record.surveyedAt) ?? '';
const titleOf = (record) => (isDoc(record) ? `Dokumentasi, ${record.photos.length} foto` : record.lokasi || record.nama || '(tanpa lokasi)');
// Whether the house was inspected. Points recorded before this existed were all inspected.
const PEMERIKSAAN = { diperiksa: 'Diperiksa', menolak: 'Menolak disurvei', 'tidak-dapat': 'Tidak dapat diperiksa' };
const ALASAN = { kosong: 'Rumah kosong / pemilik tidak ada', akses: 'Akses tidak bisa dilalui', berbahaya: 'Berbahaya untuk diperiksa', hancur: 'Bangunan hancur atau hanyut', lain: 'Lainnya' };
const statusOf = (record) => record.pemeriksaan ?? 'diperiksa';
const isRecovery = (record) => record.kind === 'recovery';
const kindOf = (record) => {
  if (isDoc(record)) return 'Dokumentasi';
  const kind = isRecovery(record) ? 'Evaluasi recovery' : 'Titik survei';
  return statusOf(record) === 'diperiksa' ? kind : `${kind}: ${PEMERIKSAAN[statusOf(record)].toLowerCase()}`;
};
// Distance in metres between a recovery evaluation and the survey it follows.
function distanceM(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(a));
}
const kecamatanOf = (record) => (isDoc(record) ? record.photos.find((p) => p.kecamatan)?.kecamatan : record.kecamatan);

// Things to look at before approving. The text checks read the text as it would be published.
function warnings(record, edits = {}) {
  const list = [];
  const published = (key) => edits[key] ?? record[key] ?? '';
  if (isDoc(record)) {
    const outside = record.photos.filter((p) => !p.kecamatan).length;
    if (outside === record.photos.length) list.push('Semua foto di luar Aceh Tamiang: tidak akan diterbitkan.');
    else if (outside) list.push(`${outside} foto di luar Aceh Tamiang dan tidak akan diterbitkan.`);
  } else {
    if (!record.kecamatan) list.push('Titik di luar Aceh Tamiang: tidak akan diterbitkan.');
    if (isRecovery(record)) {
      const base = record.base;
      if (!base?.id) list.push('Tidak terhubung ke survei awal: diisi manual oleh surveyor.');
      else {
        if (!items.some((item) => item.record.id === base.id)) list.push('Survei awal belum ada di daftar ini (belum diambil dari Drive atau belum diimpor).');
        if (base.nik && record.nik && base.nik !== record.nik) list.push('NIK berbeda dengan survei awal.');
        if (base.lat != null && record.lat != null && distanceM(record.lat, record.lon, base.lat, base.lon) > 200) list.push(`Titik berjarak ${Math.round(distanceM(record.lat, record.lon, base.lat, base.lon))} m dari survei awal. Pastikan rumah yang sama.`);
      }
    }
    if (statusOf(record) !== 'diperiksa') list.push(`${PEMERIKSAAN[statusOf(record)]}: dicatat untuk tinjauan, tidak diterbitkan sebagai titik.`);
    if (statusOf(record) === 'diperiksa' && !record.photos.length) list.push('Tidak ada foto.');
    if (statusOf(record) === 'diperiksa' && !record.signature?.image) list.push('Belum ada tanda tangan persetujuan pemilik rumah.');
    const text = `${published('lokasi')} ${published('keterangan')} ${published('dusun')}`;
    if (record.nik && text.includes(record.nik)) list.push('NIK tertulis di teks yang akan diterbitkan. Hapus dari teks.');
    if (/\b\d{16}\b/.test(text)) list.push('Ada 16 angka berturut-turut di teks (mungkin NIK).');
    if (!document.getElementById('publish-names').checked && record.nama && record.nama.length >= 3
      && text.toLowerCase().includes(record.nama.toLowerCase())) {
      list.push('Nama lengkap tertulis di teks, padahal nama tidak diterbitkan. Hapus dari teks.');
    }
  }
  return list;
}

// ------------------------------------------------------------ list

function renderFilters() {
  document.getElementById('filters').replaceChildren(...FILTERS.map(([id, label, test]) => {
    const count = items.filter((item) => test(item.state)).length;
    const button = el('button', { type: 'button', text: `${label} (${count})`, 'aria-pressed': String(id === filter) });
    button.addEventListener('click', () => {
      filter = id;
      render();
    });
    return button;
  }));
}

function render() {
  renderFilters();
  const test = FILTERS.find(([id]) => id === filter)[2];
  const shown = items.filter((item) => test(item.state)).sort((a, b) => String(dateOf(b.record)).localeCompare(String(dateOf(a.record))));
  const body = document.getElementById('records');
  if (!shown.length) {
    body.replaceChildren(el('tr', {}, el('td', { colSpan: 7, class: 'muted', text: loaded ? 'Tidak ada data di sini.' : 'Memuat…' })));
    return;
  }
  body.replaceChildren(...shown.map((item) => {
    const { record } = item;
    const flags = warnings(record, item.review?.edits);
    const open = el('button', { type: 'button', text: 'Tinjau' });
    open.addEventListener('click', () => openReview(item));
    return el('tr', {}, [
      el('td', {}, [el('strong', { text: titleOf(record) }), flags.length ? el('div', { class: 'flag', text: `⚠ ${flags.length} perlu diperiksa` }) : null]),
      el('td', { text: kindOf(record) }),
      el('td', { text: record.contributor || '—' }),
      el('td', { text: formatDate(dateOf(record)) }),
      el('td', { text: [isDoc(record) ? record.photos.find((p) => p.desa)?.desa : record.desa, kecamatanOf(record) || 'Di luar'].filter(Boolean).join(', ') }),
      el('td', {}, [el('span', { class: `state ${item.state}`, text: STATES[item.state] }), item.review?.reviewer ? el('div', { class: 'muted small', text: item.review.reviewer }) : null]),
      el('td', {}, open)
    ]);
  }));
}

async function reload() {
  const data = await api('GET', '/api/records');
  items = data.records;
  loaded = true;
  document.getElementById('publish-names').checked = Boolean(data.settings.publishNames);
  const problems = document.getElementById('problems');
  problems.textContent = data.problems.length ? `File yang tidak bisa dibaca: ${data.problems.join('; ')}` : '';
  problems.hidden = !data.problems.length;
  render();
}

// ------------------------------------------------------------ review dialog

// The survey a recovery evaluation follows: as the surveyor found it, and its review state here.
function baseSection(record) {
  const base = record.base;
  if (!base?.id) return el('p', { class: 'muted', text: 'Tidak terhubung ke survei awal (diisi manual).' });
  const here = items.find((item) => item.record.id === base.id);
  const fact = (label, value) => el('div', { class: 'fact' }, [el('dt', { text: label }), el('dd', { text: value ?? '—' })]);
  const rows = [
    fact('Nama', base.nama || '—'),
    fact('NIK', base.nik || base.nikMasked || '—'),
    fact('Desa, kecamatan', [base.desa, base.kecamatan].filter(Boolean).join(', ') || '—'),
    fact('Tanggal survei', formatDate(base.surveyedAt)),
    fact('Kerusakan saat survei', labelIn(KERUSAKAN, base.kerusakan)),
    fact('Kerusakan sekarang', labelIn(KERUSAKAN, record.kerusakan)),
    fact('Ditemukan dari', base.source === 'Drive' ? 'Google Drive' : 'perangkat surveyor'),
    fact('Di halaman ini', here ? STATES[here.state] : 'belum ada')
  ];
  if (base.lat != null && record.lat != null) {
    const d = distanceM(record.lat, record.lon, base.lat, base.lon);
    rows.push(fact('Jarak dari titik survei', d < 1000 ? `${Math.round(d)} m` : `${(d / 1000).toFixed(1)} km`));
  }
  return el('dl', { class: 'facts' }, rows);
}

function openReview(item) {
  const { record, review } = item;
  const doc = isDoc(record);
  const edits = review?.edits ?? {};
  const hiddenPhotos = new Set(review?.hiddenPhotos ?? []);
  const form = document.getElementById('review-form');
  const dialog = document.getElementById('review-dialog');

  const textField = (key, label, multiline) => {
    const value = edits[key] ?? record[key] ?? '';
    const input = multiline ? el('textarea', { rows: 4 }) : el('input', { type: 'text' });
    input.value = value;
    input.dataset.key = key;
    input.dataset.original = record[key] ?? '';
    return el('label', { class: 'review-field' }, [el('span', { text: label }), input]);
  };
  const selectField = (key, label, options) => {
    const select = el('select', {}, options.map(([value, text]) => el('option', { value, text })));
    select.value = edits[key] ?? record[key] ?? '';
    select.dataset.key = key;
    select.dataset.original = record[key] ?? '';
    return el('label', { class: 'review-field' }, [el('span', { text: label }), select]);
  };
  const fact = (label, value) => el('div', { class: 'fact' }, [el('dt', { text: label }), el('dd', { text: value ?? '—' })]);

  const photos = el('div', { class: 'review-photos' }, record.photos.map((p, i) => {
    const keep = el('input', { type: 'checkbox' });
    keep.checked = !hiddenPhotos.has(p.key);
    keep.dataset.photo = p.key;
    const parts = [el('img', { src: p.photo, alt: `Foto ${i + 1}` }), el('label', { class: 'check' }, [keep, ' Terbitkan foto ini'])];
    if (doc) {
      const caption = el('input', { type: 'text', placeholder: 'Keterangan foto' });
      caption.value = edits.captions?.[p.key] ?? p.caption ?? '';
      caption.dataset.caption = p.key;
      caption.dataset.original = p.caption ?? '';
      parts.push(caption, el('p', { class: 'hint muted', text: `${formatDate(p.takenAt)} · ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)} · ${p.kecamatan || 'di luar Aceh Tamiang'}` }));
    }
    return el('figure', {}, parts);
  }));

  const inspected = !doc && statusOf(record) === 'diperiksa';
  const facts = doc ? el('dl', { class: 'facts' }, [
    fact('Kontributor', record.contributor),
    fact('ID', record.id)
  ]) : el('dl', { class: 'facts' }, [
    fact('Status pemeriksaan', PEMERIKSAAN[statusOf(record)]),
    statusOf(record) === 'tidak-dapat' ? fact('Alasan', `${ALASAN[record.alasan] ?? '—'}${record.alasanLain ? `: ${record.alasanLain}` : ''}`) : null,
    inspected ? fact('Nama lengkap', record.nama || '—') : null,
    inspected ? fact('NIK', record.nik || '—') : null,
    isRecovery(record) && inspected ? fact('Status pemulihan', labelIn(PEMULIHAN, record.pemulihan)) : null,
    fact('Desa', record.desa || '—'),
    fact('Kecamatan', record.kecamatan || 'Di luar Aceh Tamiang'),
    fact('Koordinat', `${record.lat.toFixed(6)}, ${record.lon.toFixed(6)}${record.accuracy_m ? ` (± ${Math.round(record.accuracy_m)} m)` : ''}`),
    fact(isRecovery(record) ? 'Tanggal evaluasi' : 'Tanggal survei', formatDate(record.surveyedAt)),
    fact('ID', record.id)
  ]);

  const flags = warnings(record, edits);
  const note = el('textarea', { rows: 2 });
  note.value = review?.note ?? '';
  const buttons = [['approved', 'Setujui', 'primary'], ['rejected', 'Tolak', ''], ['pending', 'Tandai belum ditinjau', '']].map(([status, label, cls]) => {
    const button = el('button', { type: 'button', text: label, class: cls });
    button.addEventListener('click', () => save(status));
    return button;
  });

  // Parts that do not apply are null; replaceChildren would print them as the word "null".
  form.replaceChildren(...[
    el('h2', { text: `${kindOf(record)}: ${titleOf(record)}` }),
    el('p', { class: 'muted', text: `Status: ${STATES[item.state]}${review?.reviewer ? ` · peninjau ${review.reviewer}, ${formatDate(review.reviewedAt)}` : ''}` }),
    flags.length ? el('ul', { class: 'flags' }, flags.map((f) => el('li', { text: f }))) : null,
    facts,
    !inspected ? null : el('p', { class: 'hint muted', text: 'Nama lengkap, NIK dan tanda tangan hanya untuk peninjau. NIK tidak pernah diterbitkan utuh, tanda tangan tidak pernah diterbitkan, nama hanya jika dicentang di bagian 3.' }),
    !inspected ? null : el('h3', { text: 'Persetujuan dan tanda tangan pemilik' }),
    !inspected ? null : (record.signature?.image
      ? el('div', { class: 'signature' }, [
        el('img', { src: record.signature.image, alt: `Tanda tangan ${record.signature.signer || ''}`.trim() }),
        el('p', { class: 'hint muted', text: `${record.signature.signer || '—'} · ${formatDate(record.signature.signedAt)}` }),
        record.signature.consentText ? el('p', { class: 'hint muted', text: `Pernyataan: “${record.signature.consentText}”` }) : null
      ])
      : el('p', { class: 'muted', text: 'Belum ada tanda tangan.' })),
    isRecovery(record) ? el('h3', { text: 'Survei awal' }) : null,
    isRecovery(record) ? baseSection(record) : null,
    el('h3', { text: 'Teks yang diterbitkan' }),
    el('p', { class: 'hint muted', text: 'Perubahan hanya berlaku untuk data yang diterbitkan; data unggahan tetap seperti aslinya. Lokasi tidak bisa diubah.' }),
    ...(doc
      ? [textField('notes', 'Catatan dan temuan', true), textField('contributor', 'Kontributor')]
      : [
        textField('lokasi', 'Lokasi'), textField('dusun', 'Dusun'),
        inspected ? el('div', { class: 'two-col' }, [selectField('kerusakan', isRecovery(record) ? 'Kerusakan saat ini' : 'Tingkat kerusakan', KERUSAKAN), selectField('legalitas', 'Legalitas terdaftar', LEGALITAS)]) : null,
        isRecovery(record) && inspected ? selectField('pemulihan', 'Status pemulihan', PEMULIHAN) : null,
        textField('keterangan', 'Keterangan', true), textField('contributor', 'Kontributor')
      ]),
    el('h3', { text: `Foto (${record.photos.length})` }),
    record.photos.length ? photos : el('p', { class: 'muted', text: 'Tidak ada foto.' }),
    el('label', { class: 'review-field' }, [el('span', { text: 'Catatan tinjauan (tidak diterbitkan)' }), note]),
    el('p', { class: 'row' }, [...buttons, el('button', { value: 'cancel', text: 'Tutup' })])
  ].filter(Boolean));

  async function save(status) {
    const reviewer = document.getElementById('reviewer').value.trim();
    if (status !== 'pending' && !reviewer) {
      showMessage('Isi nama peninjau di bagian 2 dulu.', true);
      dialog.close();
      document.getElementById('reviewer').focus();
      return;
    }
    const textEdits = {};
    for (const input of form.querySelectorAll('[data-key]')) {
      if (input.value.trim() !== String(input.dataset.original).trim()) textEdits[input.dataset.key] = input.value.trim();
    }
    const captions = {};
    for (const input of form.querySelectorAll('[data-caption]')) {
      if (input.value.trim() !== input.dataset.original.trim()) captions[input.dataset.caption] = input.value.trim();
    }
    if (Object.keys(captions).length) textEdits.captions = captions;
    const hidden = [...form.querySelectorAll('[data-photo]')].filter((c) => !c.checked).map((c) => c.dataset.photo);
    if (status === 'approved' && doc && hidden.length === record.photos.length) {
      showMessage('Dokumentasi perlu minimal satu foto yang diterbitkan.', true);
      return;
    }
    try {
      await api('PUT', '/api/review', { id: record.id, contentKey: item.contentKey, review: { status, reviewer, edits: textEdits, hiddenPhotos: hidden, note: note.value.trim() } });
      dialog.close();
      showMessage(`${titleOf(record)}: ${STATES[status]}.`);
      await reload();
    } catch (error) {
      showMessage(error.message, true);
    }
  }

  dialog.showModal();
}

// ------------------------------------------------------------ getting data

function setupSources() {
  const codeInput = document.getElementById('admin-code');
  const remember = document.getElementById('remember-code');
  codeInput.value = store.get(CODE_KEY);
  remember.checked = Boolean(codeInput.value);

  const reviewer = document.getElementById('reviewer');
  reviewer.value = store.get(REVIEWER_KEY);
  reviewer.addEventListener('change', () => store.set(REVIEWER_KEY, reviewer.value.trim()));

  const sync = document.getElementById('sync');
  sync.addEventListener('click', async () => {
    const adminCode = codeInput.value.trim();
    if (!adminCode) return showMessage('Isi kode admin dulu.', true);
    sync.disabled = true;
    showMessage('Mengambil data dari Google Drive…');
    try {
      const result = await api('POST', '/api/sync', { adminCode });
      store.set(CODE_KEY, remember.checked ? adminCode : '');
      showMessage(`Drive: ${result.total} file; ${result.fetched} baru atau berubah disalin, ${result.unchanged} sudah ada${result.ignored ? `, ${result.ignored} file lain diabaikan` : ''}.`);
      await reload();
    } catch (error) {
      showMessage(error.message, true);
    } finally {
      sync.disabled = false;
    }
    return undefined;
  });

  const picker = document.getElementById('import-files');
  picker.addEventListener('change', async () => {
    const done = [];
    try {
      for (const file of picker.files) {
        const result = await api('POST', '/api/import', { name: file.name, text: await file.text() });
        done.push(`${file.name} (${result.entries} data)`);
      }
      showMessage(`Diimpor: ${done.join(', ')}.`);
    } catch (error) {
      showMessage(`${done.length ? `Diimpor: ${done.join(', ')}. ` : ''}${error.message}`, true);
    }
    picker.value = '';
    await reload();
  });
}

// ------------------------------------------------------------ publishing and GitHub

function setupPublish() {
  const names = document.getElementById('publish-names');
  names.addEventListener('change', async () => {
    if (names.checked && !confirm('Nama lengkap pemilik akan tampil di dasbor publik dan di GitHub. Lanjutkan?')) {
      names.checked = false;
      return;
    }
    try {
      await api('PUT', '/api/settings', { publishNames: names.checked });
      render();
    } catch (error) {
      showMessage(error.message, true);
    }
  });

  const button = document.getElementById('publish');
  const log = document.getElementById('publish-log');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const r = await api('POST', '/api/publish');
      const waiting = Object.entries(r.waiting).map(([state, n]) => `${n} ${STATES[state].toLowerCase()}`).join(', ') || 'tidak ada';
      log.textContent = [
        `Diterbitkan: ${r.points} titik survei, ${r.recoveries} evaluasi recovery, ${r.photos} foto dokumentasi.`,
        `Tidak diterbitkan: ${waiting}.`,
        Object.keys(r.notInspected).length ? `Disetujui tetapi tidak diterbitkan sebagai titik: ${Object.entries(r.notInspected).map(([s, n]) => `${n} ${PEMERIKSAAN[s].toLowerCase()}`).join(', ')}.` : '',
        `Nama lengkap ${r.publishNames ? 'DITERBITKAN' : 'tidak diterbitkan'}; NIK hanya 4 angka terakhir.`,
        r.removedPhotos ? `${r.removedPhotos} foto lama dihapus.` : '',
        ...r.log
      ].filter(Boolean).join('\n');
      log.hidden = false;
      showMessage('Selesai. Periksa dasbor, lalu unggah ke GitHub di bagian 4.');
      await refreshGit();
    } catch (error) {
      showMessage(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
}

async function refreshGit() {
  const box = document.getElementById('git-state');
  try {
    const s = await api('GET', '/api/git');
    const lines = [`Cabang ${s.branch}.`];
    lines.push(s.changes.length ? `${s.changes.length} file berubah di titik-survey/data/.` : 'Tidak ada perubahan di titik-survey/data/.');
    if (s.ahead) lines.push(`${s.ahead} commit belum di-push.`);
    if (s.behind) lines.push(`GitHub punya ${s.behind} commit yang belum ada di sini.`);
    box.textContent = lines.join(' ');
  } catch (error) {
    box.textContent = error.message;
  }
}

function setupGit() {
  const button = document.getElementById('git-push');
  button.addEventListener('click', async () => {
    button.disabled = true;
    showMessage('Mengunggah ke GitHub…');
    try {
      const r = await api('POST', '/api/git/push', { message: document.getElementById('git-message').value });
      showMessage(r.pushed ? `Terunggah ke GitHub${r.committed ? `: ${r.committed}` : ''}.` : r.note);
      document.getElementById('git-message').value = '';
    } catch (error) {
      showMessage(error.message, true);
    } finally {
      button.disabled = false;
      await refreshGit();
    }
  });
  refreshGit();
}

setupSources();
setupPublish();
setupGit();
render();
reload().catch((error) => showMessage(error.message, true));
