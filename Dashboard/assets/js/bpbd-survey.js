// "Hasil survei BPBD": the published results of the building damage survey, read-only.
//
// Nothing is added here. Surveyors record houses in the survey app (../Survey/), BPBD reviewers
// approve them on the local review page (admin/), and the review page publishes the approved
// ones into data/web/: bpbd_survey.geojson (inspected houses), bpbd_rekonstruksi.geojson
// (reconstruction evaluations) and bpbd_documentation.geojson (field photos, one feature per
// photo). Published data holds only the last four digits of a NIK and never a signature.
import { el } from './dom.js';
import { pointReport } from './point-report.js';

const DAMAGE_ORDER = ['berat', 'sedang', 'rendah'];

export function createSurveyResults({ datasets, i18n, reportSources, onGoTo }) {
  const { t, pick } = i18n;
  let points = [];
  let rekonstruksi = [];
  let docs = [];
  let lastDetail = 0;
  const dialog = document.getElementById('survey-dialog');
  const locale = () => (document.documentElement.lang === 'id' ? 'id-ID' : 'en-GB');
  const formatDate = (value) => (value ? new Date(value).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const damageLabel = (id) => (DAMAGE_ORDER.includes(id) ? t(`survey.damageLevels.${id}`) : '—');
  const legalLabel = (id) => (id === 'ya' ? t('survey.yes') : id === 'tidak' ? t('survey.no') : '—');
  const progressLabel = (n) => (Number.isFinite(n) ? `${n}%` : '—');
  const place = (p) => [p.desa ? `Desa ${p.desa}` : null, p.kecamatan ?? t('survey.outside')].filter(Boolean).join(' · ');

  const fromFeatures = (collection) => collection.features.map((f) => ({ ...f.properties, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] }));

  // ------------------------------------------------------------------ lists

  function row(entry, title, badge, onOpen, datasetId) {
    const button = el('button', 'survey-row');
    button.type = 'button';
    button.append(el('span', 'survey-row-place', title), badge, el('span', 'survey-row-meta', `${place(entry)} · ${formatDate(entry.surveyedAt)}`));
    button.addEventListener('click', onOpen);
    const goTo = el('button', 'survey-goto', t('survey.goTo'));
    goTo.type = 'button';
    goTo.addEventListener('click', () => onGoTo(datasetId, entry.lon, entry.lat));
    const item = el('li', 'survey-item');
    item.append(button, goTo);
    return item;
  }

  function fill(listId, countId, entries, empty, make) {
    document.getElementById(countId).textContent = entries.length;
    const list = document.getElementById(listId);
    list.replaceChildren(...(entries.length ? entries.map(make) : [el('li', 'empty', empty)]));
  }

  function render() {
    // Most severe damage first, then newest; evaluations newest first.
    const sortedPoints = [...points].sort((a, b) => DAMAGE_ORDER.indexOf(a.kerusakan) - DAMAGE_ORDER.indexOf(b.kerusakan)
      || String(b.surveyedAt).localeCompare(String(a.surveyedAt)));
    fill('survey-rows-points', 'survey-count-points', sortedPoints, t('survey.emptyPoints'), (p) => row(
      p, p.lokasi || p.nama || place(p),
      el('span', `survey-badge damage-${p.kerusakan || 'none'}`, damageLabel(p.kerusakan)),
      () => showPoint(p), datasets.points.id
    ));
    const sortedRekon = [...rekonstruksi].sort((a, b) => String(b.surveyedAt).localeCompare(String(a.surveyedAt)));
    fill('survey-rows-rekonstruksi', 'survey-count-rekonstruksi', sortedRekon, t('survey.emptyRekonstruksi'), (r) => row(
      r, r.lokasi || r.nama || place(r),
      el('span', `survey-badge progress progress-${Number.isFinite(r.pemulihan) ? r.pemulihan : 'none'}`, progressLabel(r.pemulihan)),
      () => showRekonstruksi(r), datasets.rekonstruksi.id
    ));
  }

  // ------------------------------------------------------------------ detail windows

  function openDialog(title, body) {
    const close = el('button', null, t('close'));
    close.type = 'button';
    close.addEventListener('click', () => dialog.close());
    const head = el('div', 'dialog-head');
    head.append(el('h2', null, title), close);
    const content = el('div', 'survey-dialog-body');
    content.append(...body.filter(Boolean));
    dialog.replaceChildren(head, content);
    if (!dialog.open) dialog.showModal();
  }

  function fact(label, value) {
    const item = el('div', 'survey-fact');
    item.append(el('dt', null, label), el('dd', null, value ?? '—'));
    return item;
  }

  function gallery(photos, current = 0, onPick = null) {
    if (!photos?.length) return el('p', 'note', t('survey.noPhotos'));
    const wrap = el('div', 'survey-gallery');
    const main = el('img', 'survey-gallery-main');
    main.src = photos[current];
    main.alt = t('survey.photos');
    wrap.append(main);
    if (photos.length > 1) {
      const strip = el('div', 'survey-gallery-strip');
      photos.forEach((src, i) => {
        const button = el('button');
        button.type = 'button';
        button.setAttribute('aria-label', `${t('survey.photos')} ${i + 1}`);
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

  // What the map layers say at the point: flood, hazard, land cover, population.
  function locationReport(entry) {
    const section = el('div', 'survey-report');
    const body = el('p', 'note', t('survey.reportLoading'));
    section.append(el('h3', null, t('survey.report')), body);
    if (!entry.kecamatan) {
      body.textContent = t('survey.outside');
      return section;
    }
    pointReport({ ...reportSources(), i18n }, entry.lon, entry.lat).then((groups) => {
      const content = groups.flatMap((group) => {
        const rows = el('dl', 'survey-facts');
        rows.append(...group.rows.map((r) => fact(r.label, r.value)));
        return [el('h4', null, group.label), rows];
      });
      const sources = [...new Set(groups.flatMap((group) => group.rows.map((r) => r.source)))].join('; ');
      body.replaceWith(...content, el('p', 'note', t('survey.reportNote')), el('p', 'note', `${t('source')}: ${sources}`));
    }).catch(() => {
      body.textContent = t('survey.reportFailed');
    });
    return section;
  }

  // The owner's name appears only when the reviewers chose to publish names.
  const ownerFacts = (e) => [e.nama ? fact(t('survey.owner'), e.nama) : null, e.nik ? fact(t('survey.nik'), e.nik) : null];
  const reviewFacts = (e) => [fact(t('survey.contributor'), e.contributor || '—'), fact(t('survey.reviewer'), e.reviewer || '—'), fact(t('survey.reviewedAt'), formatDate(e.reviewedAt))];
  const notes = (e) => [el('h3', null, t('survey.notes')), e.keterangan ? el('p', 'survey-findings', e.keterangan) : el('p', 'note', '—')];

  function showPoint(p) {
    const facts = el('dl', 'survey-facts');
    facts.append(...[
      fact(t('survey.damage'), damageLabel(p.kerusakan)),
      fact(t('survey.location'), p.lokasi || '—'),
      ...ownerFacts(p),
      fact(t('survey.dusun'), p.dusun || '—'),
      fact(t('survey.desa'), p.desa || '—'),
      fact(t('kecamatan'), p.kecamatan ?? t('survey.outside')),
      fact(t('survey.legal'), legalLabel(p.legalitas)),
      fact(t('survey.coordinates'), `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`),
      fact(t('survey.surveyDate'), formatDate(p.surveyedAt)),
      ...reviewFacts(p)
    ].filter(Boolean));
    openDialog(p.lokasi || p.nama || pick(datasets.points.label), [gallery(p.photos), facts, ...notes(p), ...evaluationsOf(p), locationReport(p)]);
  }

  // The house's reconstruction evaluations, newest first, each opening its own window. They sit
  // on the same spot as the survey point, so this is how they are reached from it.
  function evaluationsOf(p) {
    const list = rekonstruksi.filter((r) => r.baseId === p.id).sort((a, b) => String(b.surveyedAt).localeCompare(String(a.surveyedAt)));
    if (!list.length) return [];
    const items = el('ul', 'survey-links');
    items.append(...list.map((r) => {
      const button = el('button', 'survey-link', `${progressLabel(r.pemulihan)} · ${formatDate(r.surveyedAt)}`);
      button.type = 'button';
      button.addEventListener('click', () => showRekonstruksi(r));
      const item = el('li');
      item.append(button);
      return item;
    }));
    return [el('h3', null, t('survey.rekonstruksi')), items];
  }

  // From an evaluation back to its survey point, when that point is published.
  function baseLink(r) {
    const base = points.find((p) => p.id === r.baseId);
    if (!base) return null;
    const button = el('button', 'survey-link', `${t('survey.points')}: ${base.lokasi || base.nama || place(base)} · ${damageLabel(base.kerusakan)}`);
    button.type = 'button';
    button.addEventListener('click', () => showPoint(base));
    return button;
  }

  function showRekonstruksi(r) {
    const facts = el('dl', 'survey-facts');
    facts.append(...[
      fact(t('survey.progress'), progressLabel(r.pemulihan)),
      fact(t('survey.damageAtSurvey'), damageLabel(r.kerusakanAwal)),
      fact(t('survey.location'), r.lokasi || '—'),
      ...ownerFacts(r),
      fact(t('survey.dusun'), r.dusun || '—'),
      fact(t('survey.desa'), r.desa || '—'),
      fact(t('kecamatan'), r.kecamatan ?? t('survey.outside')),
      fact(t('survey.legal'), legalLabel(r.legalitas)),
      fact(t('survey.evaluationDate'), formatDate(r.surveyedAt)),
      fact(t('survey.earlierSurvey'), formatDate(r.baseSurveyedAt)),
      ...reviewFacts(r)
    ].filter(Boolean));
    openDialog(`${t('survey.rekonstruksi')}: ${r.lokasi || r.nama || place(r)}`, [gallery(r.photos), facts, baseLink(r), ...notes(r), locationReport(r)]);
  }

  // One documentation entry, one photo at a time, each with its own location and time.
  function showDocumentation(id, index = 0) {
    const photos = docs.filter((d) => d.id === id).sort((a, b) => a.photo - b.photo);
    if (!photos.length) return;
    const at = Math.min(Math.max(Number(index) || 0, 0), photos.length - 1);
    const photo = photos[at];
    const facts = el('dl', 'survey-facts');
    facts.append(
      fact(t('survey.caption'), photo.caption || '—'),
      fact(t('survey.photos'), t('survey.photoOf').replace('{i}', at + 1).replace('{n}', photos.length)),
      fact(t('survey.desa'), photo.desa || '—'),
      fact(t('kecamatan'), photo.kecamatan ?? t('survey.outside')),
      fact(t('survey.coordinates'), `${photo.lat.toFixed(5)}, ${photo.lon.toFixed(5)}`),
      fact(t('survey.takenAt'), formatDate(photo.takenAt)),
      fact(t('survey.contributor'), photo.contributor || '—'),
      fact(t('survey.reviewer'), photo.reviewer || '—')
    );
    openDialog(t('survey.docTitle'), [
      gallery(photos.map((p) => p.url), at, (i) => showDocumentation(id, i)),
      facts,
      el('p', 'note', t('survey.docLocationNote')),
      el('h3', null, t('survey.docNotes')),
      photo.notes ? el('p', 'survey-findings', photo.notes) : el('p', 'note', '—'),
      locationReport(photo)
    ]);
  }

  return {
    async init() {
      const load = async (dataset) => {
        const response = await fetch(dataset.file, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Could not load ${dataset.file} (${response.status})`);
        return fromFeatures(await response.json());
      };
      [points, rekonstruksi, docs] = await Promise.all([load(datasets.points), load(datasets.rekonstruksi), load(datasets.docs)]);
      render();
    },
    render,
    // Called by the map when a point, an evaluation or a photo is clicked. An evaluation sits on
    // its survey point, so one click can reach two layers: the first one called opens.
    showDetail(datasetId, properties) {
      const now = Date.now();
      if (now - lastDetail < 300) return undefined;
      lastDetail = now;
      if (datasetId === datasets.docs.id) return showDocumentation(properties.id, properties.photo);
      const list = datasetId === datasets.rekonstruksi.id ? rekonstruksi : points;
      const entry = list.find((e) => e.id === properties.id);
      if (!entry) return undefined;
      return datasetId === datasets.rekonstruksi.id ? showRekonstruksi(entry) : showPoint(entry);
    }
  };
}
