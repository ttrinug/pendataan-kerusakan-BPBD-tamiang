"""Village (desa/kelurahan) boundaries for the survey app.

Input:  "for claude/Tamkd.shp"   BIG Batas Desa/Kelurahan (TASWIL1000020260612DESAKEL_AR), clipped to
                                the Tamiang river basin, so it also holds desa of other kabupaten
        Survey/data/kecamatan.geojson   BIG kecamatan boundaries used by the app
Output: Survey/data/desa.geojson

Keeps the desa of Kabupaten Aceh Tamiang (KDPKAB 11.16) only, with their code, name, kecamatan
and boundary status.

Gaps: parts of a kecamatan that no desa polygon covers (about 70 km2 in the south of
Tenggulun, and small slivers along rivers and the coast elsewhere) are added to the desa of the
same kecamatan they share the longest border with, or the nearest one if they touch none. So
every point inside a kecamatan gets a desa. Expanded desa carry "addedKm2". BIG marks most
boundaries as indicative; these additions are an approximation on top of that.

Boundaries are simplified by about 5 m and coordinates rounded to about 1 m, so the file stays
small enough to load on a phone.

Run from the repository folder with a Python that has GeoPandas, for example the one in the
copied Dashboard (or the vulnerability mapping project):
    Dashboard/.venv/Scripts/python.exe admin/tools/build_desa.py
"""
import json
import sys
from pathlib import Path

import geopandas as gpd
from shapely.geometry import mapping
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[2]  # the repository folder (this file is in admin/tools/)
SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "for claude" / "Tamkd.shp"
KECAMATAN = ROOT / "Survey" / "data" / "kecamatan.geojson"
OUT = ROOT / "Survey" / "data" / "desa.geojson"
METRIC = "EPSG:32647"  # UTM 47N, for areas and distances in metres
MIN_GAP_M2 = 100  # smaller slivers are rounding noise
SIMPLIFY_DEGREES = 0.00005  # about 5.5 m
DECIMALS = 5  # about 1.1 m


def rounded(coords):
    if isinstance(coords[0], (float, int)):
        return [round(coords[0], DECIMALS), round(coords[1], DECIMALS)]
    return [rounded(c) for c in coords]


def fill_gaps(desa, kecamatan):
    """Adds the uncovered parts of each kecamatan to a neighbouring desa of that kecamatan."""
    desa = desa.to_crs(METRIC).copy()
    desa["addedKm2"] = 0.0
    covered = desa.union_all()
    for _, kec in kecamatan.to_crs(METRIC).iterrows():
        mine = desa.index[desa["KDCPUM"] == kec["code"]]
        if not len(mine):
            continue
        gap = kec.geometry.difference(covered)
        for part in getattr(gap, "geoms", [gap]):
            if part.is_empty or part.area < MIN_GAP_M2:
                continue
            # The longest shared border decides; a gap that touches no desa goes to the nearest.
            shared = {i: desa.at[i, "geometry"].intersection(part.buffer(1)).length for i in mine}
            target = max(shared, key=shared.get) if max(shared.values()) > 0 else min(mine, key=lambda i: desa.at[i, "geometry"].distance(part))
            desa.at[target, "geometry"] = unary_union([desa.at[target, "geometry"], part.buffer(0.5)]).buffer(0)
            desa.at[target, "addedKm2"] += part.area / 1e6
    return desa.to_crs("EPSG:4326")


def main():
    desa = gpd.read_file(SOURCE).to_crs("EPSG:4326")
    desa = desa[desa["KDPKAB"] == "11.16"].copy()
    desa = fill_gaps(desa, gpd.read_file(KECAMATAN))
    desa["geometry"] = desa.geometry.simplify(SIMPLIFY_DEGREES, preserve_topology=True).buffer(0)
    features = []
    for _, row in desa.sort_values("KDEPUM").iterrows():
        geometry = mapping(row.geometry)
        # A point always inside the desa (unlike a centroid), for its map label.
        label = row.geometry.representative_point()
        properties = {
            "code": row["KDEPUM"],
            "name": row["WADMKD"],
            "kecamatan": row["WADMKC"],
            "kecamatanCode": row["KDCPUM"],
            "status": row["Status"],
            "persiapan": "Kampung persiapan" in str(row["REMARK"]),
            "label": [round(label.x, DECIMALS), round(label.y, DECIMALS)],
        }
        if row["addedKm2"] >= 0.01:
            properties["addedKm2"] = round(row["addedKm2"], 2)
        features.append({"type": "Feature", "properties": properties, "geometry": {"type": geometry["type"], "coordinates": rounded(geometry["coordinates"])}})
    OUT.write_text(
        '{"type":"FeatureCollection","features":[\n' + ",\n".join(json.dumps(f, ensure_ascii=False, separators=(",", ":")) for f in features) + "\n]}\n",
        encoding="utf-8",
    )
    print(f"{len(features)} desa written to {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1e6:.2f} MB)")
    expanded = desa[desa["addedKm2"] >= 0.01].sort_values("addedKm2", ascending=False)
    print("Expanded to fill gaps:", "; ".join(f"{r.WADMKD} ({r.WADMKC}) +{r.addedKm2:.2f} km2" for r in expanded.itertuples()))
    print("Boundary status:", desa["Status"].value_counts().to_dict())


if __name__ == "__main__":
    main()
