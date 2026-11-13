// The map block: basemaps, data layers, survey points and documentation photos.
import * as maplibregl from 'https://cdn.jsdelivr.net/npm/maplibre-gl@6.15.0/dist/maplibre-gl.mjs';
import { el } from './dom.js';

const POINT_ZOOM = 16;
const SELECTED_FILL = '#08519c';

function styleFor(basemap) {
  if (basemap.type === 'style') return basemap.style;
  return {
    version: 8,
    glyphs: basemap.glyphs,
    sources: { [basemap.id]: { type: 'raster', tiles: basemap.tiles, tileSize: basemap.tileSize, maxzoom: basemap.maxzoom } },
    layers: [{ id: basemap.id, type: 'raster', source: basemap.id }]
  };
}

// [west, south, east, north] of one GeoJSON feature.
function featureBounds(feature) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const visit = (coords) => {
    if (typeof coords[0] === 'number') {
      bounds[0] = Math.min(bounds[0], coords[0]);
      bounds[1] = Math.min(bounds[1], coords[1]);
      bounds[2] = Math.max(bounds[2], coords[0]);
      bounds[3] = Math.max(bounds[3], coords[1]);
    } else {
      coords.forEach(visit);
    }
  };
  visit(feature.geometry.coordinates);
  return bounds;
}

// The documentation icon (a camera), in the colour of its status.
export function cameraSvg(color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 32 32">
  <circle cx="16" cy="16" r="14" fill="${color}" stroke="#ffffff" stroke-width="2"/>
  <path d="M8.5 12 H12 L13.5 9.5 H18.5 L20 12 H23.5 V22.5 H8.5 Z" fill="#ffffff"/>
  <circle cx="16" cy="17" r="3.4" fill="${color}"/>
  <circle cx="16" cy="17" r="1.6" fill="#ffffff"/>
</svg>`;
}
export const cameraUrl = (color) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(cameraSvg(color))}`;

async function loadImage(src) {
  const image = new Image();
  image.src = src;
  await image.decode();
  return image;
}

// Map layer ids for each configured layer, so the layer list can show and hide them.
const MAP_LAYERS = {
  lulc: ['lulc-image'],
  flood: ['flood-fill', 'flood-outline'],
  kecamatan: ['kecamatan-fill', 'kecamatan-casing', 'kecamatan-line', 'kecamatan-label'],
  desa: ['desa-line']
};

class LayerControl {
  constructor(options) { Object.assign(this, options); }

  onAdd() {
    this.container = el('details', 'maplibregl-ctrl layer-control');
    this.render();
    return this.container;
  }

  onRemove() { this.container.remove(); }

  render() {
    const body = el('div', 'layer-control-body');
    const basemapSet = el('fieldset');
    basemapSet.append(el('legend', null, 'Peta dasar'));
    for (const basemap of this.config.basemaps) {
      const input = el('input');
      input.type = 'radio';
      input.name = 'basemap';
      input.checked = basemap.id === this.basemapId;
      input.addEventListener('change', () => this.onBasemap(basemap));
      const label = el('label', 'option');
      label.append(input, basemap.label);
      basemapSet.append(label);
    }

    const layerSet = el('fieldset');
    layerSet.append(el('legend', null, 'Lapisan data'));
    for (const layer of this.config.layers) {
      const input = el('input');
      input.type = 'checkbox';
      input.disabled = !layer.file;
      input.checked = this.visible.has(layer.id);
      input.addEventListener('change', () => this.onToggle(layer, input.checked));
      const label = el('label', input.disabled ? 'option disabled' : 'option');
      const text = el('span', null, layer.label);
      if (input.disabled) text.append(el('span', 'status', layer.note ?? 'Belum ada data'));
      label.append(input, text);
      layerSet.append(label);
    }

    body.append(basemapSet, layerSet);
    this.container.replaceChildren(el('summary', null, 'Lapisan'), body);
  }
}

// The legend on the map: survey points and documentation in both statuses, then the layers
// that are switched on.
class LegendControl {
  // On a phone the legend would cover much of the map, so it starts folded.
  constructor(config) {
    this.config = config;
    this.collapsed = window.innerWidth < 640;
  }

  onAdd() {
    this.container = el('div', 'maplibregl-ctrl map-legend');
    return this.container;
  }

  onRemove() { this.container.remove(); }

  render(visible) {
    const { colors } = this.config;
    const entry = (swatchClass, color, text) => {
      const row = el('li');
      const swatch = el('span', swatchClass);
      swatch.style.setProperty('--swatch', color);
      swatch.setAttribute('aria-hidden', 'true');
      row.append(swatch, text);
      return row;
    };
    const icon = (color, text) => {
      const row = el('li');
      const image = el('img', 'swatch-icon');
      image.src = cameraUrl(color);
      image.alt = '';
      row.append(image, text);
      return row;
    };
    const points = el('ul', 'legend-items');
    points.append(
      entry('swatch swatch-point', colors.local, 'Titik survei lokal'),
      entry('swatch swatch-point', colors.reviewed, 'Titik survei ditinjau'),
      icon(colors.local, 'Dokumentasi lokal'),
      icon(colors.reviewed, 'Dokumentasi ditinjau')
    );
    const content = [el('p', 'legend-title', 'Legenda'), points];
    for (const layer of this.config.layers.filter((l) => visible.has(l.id))) {
      const list = el('ul', 'legend-items');
      if (layer.type === 'boundaries') list.append(entry('swatch swatch-line', layer.color, layer.label));
      else if (layer.type === 'fill') list.append(entry('swatch swatch-fill', layer.color, layer.label));
      else if (layer.legend) {
        list.append(...layer.legend.map((item) => entry('swatch swatch-fill', item.color, item.label)));
        content.push(el('p', 'legend-group', layer.label));
      }
      content.push(list);
    }
    const toggle = el('button', 'legend-toggle', this.collapsed ? 'Legenda ▸' : '▾');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(!this.collapsed));
    toggle.setAttribute('aria-label', this.collapsed ? 'Tampilkan legenda' : 'Sembunyikan legenda');
    toggle.addEventListener('click', () => {
      this.collapsed = !this.collapsed;
      this.render(visible);
    });
    this.container.replaceChildren(toggle, ...(this.collapsed ? [] : content));
  }
}

class CaptionControl {
  onAdd() {
    this.container = el('p', 'maplibregl-ctrl imagery-note');
    this.container.hidden = true;
    return this.container;
  }

  onRemove() { this.container.remove(); }

  set(text) {
    this.container.textContent = text || '';
    this.container.hidden = !text;
  }
}

const emptyCollection = () => ({ type: 'FeatureCollection', features: [] });

export async function createMap({ config, onPointClick, onDocClick, onKecamatanClick }) {
  let basemap = config.basemaps[0];
  let selectedCode = null;
  const visible = new Set(config.layers.filter((l) => l.file && l.visible).map((l) => l.id));
  const layerById = (id) => config.layers.find((l) => l.id === id);
  const load = async (path) => (await fetch(path)).json();
  const [kecamatanData, floodData, localIcon, reviewedIcon] = await Promise.all([
    load(layerById('kecamatan').file),
    load(layerById('flood').file),
    loadImage(cameraUrl(config.colors.local)),
    loadImage(cameraUrl(config.colors.reviewed))
  ]);
  const boundaries = kecamatanData.features;
  // One label per kecamatan, at the middle of its largest part's bounding box.
  const labels = {
    type: 'FeatureCollection',
    features: boundaries.map((f) => {
      const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      const ring = polygons.map((p) => p[0]).sort((a, b) => b.length - a.length)[0];
      const xs = ring.map((c) => c[0]);
      const ys = ring.map((c) => c[1]);
      const centre = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
      return { type: 'Feature', properties: { code: f.properties.code, name: f.properties.name }, geometry: { type: 'Point', coordinates: centre } };
    })
  };
  let points = emptyCollection();
  let docs = emptyCollection();

  const map = new maplibregl.Map({
    container: 'map',
    style: styleFor(basemap),
    bounds: config.bounds,
    fitBoundsOptions: { padding: 20 },
    minZoom: config.minZoom,
    maxZoom: config.maxZoom,
    attributionControl: false
  });

  const visibility = (id) => (visible.has(id) ? 'visible' : 'none');
  // The selected kecamatan is shown by a thicker line and a light fill, not by colour alone.
  const isSelected = () => ['==', ['get', 'code'], selectedCode ?? ''];
  const selectionPaint = () => ({
    'kecamatan-fill': { 'fill-opacity': ['case', isSelected(), 0.12, 0] },
    'kecamatan-casing': { 'line-width': ['case', isSelected(), 6, 3] },
    'kecamatan-line': { 'line-width': ['case', isSelected(), 3, 1.2] }
  });

  // Data layers are part of the style, so they are added again after every basemap switch.
  map.on('style.load', () => {
    for (const [id, image] of [['doc-local', localIcon], ['doc-reviewed', reviewedIcon]]) {
      if (!map.hasImage(id)) map.addImage(id, image, { pixelRatio: 2 });
    }
    const paint = selectionPaint();

    const lulc = layerById('lulc');
    map.addSource('lulc', { type: 'image', url: lulc.file, coordinates: lulc.coordinates });
    map.addLayer({
      id: 'lulc-image', type: 'raster', source: 'lulc',
      layout: { visibility: visibility('lulc') },
      paint: { 'raster-opacity': 0.8, 'raster-resampling': 'nearest', 'raster-fade-duration': 0 }
    });

    const flood = layerById('flood');
    map.addSource('flood', { type: 'geojson', data: floodData, attribution: flood.attribution });
    map.addLayer({ id: 'flood-fill', type: 'fill', source: 'flood', layout: { visibility: visibility('flood') }, paint: { 'fill-color': flood.color, 'fill-opacity': 0.6 } });
    map.addLayer({ id: 'flood-outline', type: 'line', source: 'flood', layout: { visibility: visibility('flood') }, paint: { 'line-color': flood.color, 'line-width': 0.5 } });

    const kec = layerById('kecamatan');
    map.addSource('kecamatan', { type: 'geojson', data: kecamatanData, attribution: kec.attribution });
    map.addSource('kecamatan-labels', { type: 'geojson', data: labels });
    map.addLayer({ id: 'kecamatan-fill', type: 'fill', source: 'kecamatan', layout: { visibility: visibility('kecamatan') }, paint: { 'fill-color': SELECTED_FILL, ...paint['kecamatan-fill'] } });

    // Village boundaries: drawn once their file is set in config.json.
    const desa = layerById('desa');
    if (desa.file) {
      map.addSource('desa', { type: 'geojson', data: desa.file, attribution: desa.attribution });
      map.addLayer({ id: 'desa-line', type: 'line', source: 'desa', layout: { visibility: visibility('desa') }, paint: { 'line-color': desa.color, 'line-width': 0.8, 'line-dasharray': [2, 1] } });
    }

    map.addLayer({ id: 'kecamatan-casing', type: 'line', source: 'kecamatan', layout: { visibility: visibility('kecamatan') }, paint: { 'line-color': '#ffffff', 'line-opacity': 0.8, ...paint['kecamatan-casing'] } });
    map.addLayer({ id: 'kecamatan-line', type: 'line', source: 'kecamatan', layout: { visibility: visibility('kecamatan') }, paint: { 'line-color': kec.color, ...paint['kecamatan-line'] } });
    map.addLayer({
      id: 'kecamatan-label', type: 'symbol', source: 'kecamatan-labels',
      layout: {
        visibility: visibility('kecamatan'),
        'text-field': ['get', 'name'],
        'text-font': ['Noto Sans Regular'],
        'text-size': ['case', isSelected(), 14, 12]
      },
      paint: { 'text-color': '#1f2933', 'text-halo-color': '#ffffff', 'text-halo-width': 1.5 }
    });

    map.addSource('points', { type: 'geojson', data: points });
    map.addLayer({
      id: 'points', type: 'circle', source: 'points',
      paint: {
        'circle-color': ['match', ['get', 'status'], 'reviewed', config.colors.reviewed, config.colors.local],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 4, 14, 7, 18, 10],
        'circle-stroke-color': '#ffffff',
        'circle-stroke-width': 1.5
      }
    });
    map.addSource('docs', { type: 'geojson', data: docs });
    map.addLayer({
      id: 'docs', type: 'symbol', source: 'docs',
      layout: {
        'icon-image': ['match', ['get', 'status'], 'reviewed', 'doc-reviewed', 'doc-local'],
        'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.4, 12, 0.6, 16, 0.9],
        'icon-allow-overlap': true
      }
    });
  });

  // A click on a point or photo opens it and must not also select the kecamatan below it.
  map.on('click', (event) => {
    const hits = map.queryRenderedFeatures(event.point, { layers: ['docs', 'points'].filter((id) => map.getLayer(id)) });
    if (hits.length) {
      const { id, status, photo } = hits[0].properties;
      if (hits[0].layer.id === 'docs') onDocClick(id, Number(photo) || 0, status);
      else onPointClick(id, status);
      return;
    }
    if (!visible.has('kecamatan')) return;
    const [kecamatan] = map.queryRenderedFeatures(event.point, { layers: ['kecamatan-fill'] });
    if (kecamatan) onKecamatanClick(kecamatan.properties.code);
  });
  for (const layer of ['points', 'docs', 'kecamatan-fill']) {
    map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = ''; });
  }

  let attribution;
  function setAttribution() {
    if (attribution) map.removeControl(attribution);
    const extra = visible.has('lulc') ? [layerById('lulc').attribution] : [];
    attribution = new maplibregl.AttributionControl({ compact: false, customAttribution: [basemap.attribution, ...extra] });
    map.addControl(attribution, 'bottom-right');
  }

  const legend = new LegendControl(config);
  const caption = new CaptionControl();
  const layerControl = new LayerControl({
    config,
    basemapId: basemap.id,
    visible,
    onBasemap(next) {
      basemap = next;
      this.basemapId = next.id;
      map.setStyle(styleFor(next));
      setAttribution();
      caption.set(next.caption);
    },
    onToggle(layer, on) {
      if (on) visible.add(layer.id);
      else visible.delete(layer.id);
      for (const id of MAP_LAYERS[layer.id] ?? []) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
      }
      if (layer.id === 'lulc') setAttribution();
      legend.render(visible);
    }
  });

  map.addControl(layerControl, 'top-left');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.addControl(caption, 'top-right');
  map.addControl(legend, 'bottom-left');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
  setAttribution();
  legend.render(visible);

  // The attribution can wrap onto several lines; keep the legend and scale bar just above it.
  const attributionArea = map.getContainer().querySelector('.maplibregl-ctrl-bottom-right');
  new ResizeObserver(() => {
    map.getContainer().style.setProperty('--attribution-height', `${attributionArea.offsetHeight}px`);
  }).observe(attributionArea);

  return {
    boundaries,

    setData(nextPoints, nextDocs) {
      points = nextPoints;
      docs = nextDocs;
      map.getSource('points')?.setData(points);
      map.getSource('docs')?.setData(docs);
    },

    goTo(lon, lat) {
      map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), POINT_ZOOM) });
      map.getContainer().scrollIntoView({ behavior: 'smooth', block: 'center' });
    },

    // Highlights a kecamatan and zooms to it; null goes back to the whole kabupaten.
    selectKecamatan(code) {
      selectedCode = code;
      for (const [layerId, props] of Object.entries(selectionPaint())) {
        for (const [property, value] of Object.entries(props)) {
          if (map.getLayer(layerId)) map.setPaintProperty(layerId, property, value);
        }
      }
      if (map.getLayer('kecamatan-label')) map.setLayoutProperty('kecamatan-label', 'text-size', ['case', isSelected(), 14, 12]);
      const feature = boundaries.find((f) => f.properties.code === code);
      if (feature) map.fitBounds(featureBounds(feature), { padding: 40, maxZoom: 13 });
      else map.fitBounds(config.bounds, { padding: 20 });
    }
  };
}
