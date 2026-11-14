"""Village (desa/kelurahan) boundaries for the survey app.

Input:  "for claude/Tamkd.shp"   BIG Batas Desa/Kelurahan (TASWIL1000020260612DESAKEL_AR), clipped to
                                the Tamiang river basin, so it also holds desa of other kabupaten
Output: titik-survey/data/desa.geojson

Keeps the desa of Kabupaten Aceh Tamiang (KDPKAB 11.16) only, with their code, name, kecamatan
and boundary status. Boundaries are simplified by about 5 m and coordinates rounded to about
1 m, so the file stays small enough to load on a phone; the survey app uses it to draw the
layer and to name the desa a point lies in.

Run from the repository folder with a Python that has GeoPandas, for example the one in the
vulnerability mapping project:
    "../5. Dashboard/.venv/Scripts/python.exe" scripts/build_desa.py
"""
import json
import sys
from pathlib import Path

import geopandas as gpd
from shapely.geometry import mapping

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "for claude" / "Tamkd.shp"
OUT = ROOT / "titik-survey" / "data" / "desa.geojson"
SIMPLIFY_DEGREES = 0.00005  # about 5.5 m
DECIMALS = 5  # about 1.1 m


def rounded(coords):
    if isinstance(coords[0], (float, int)):
        return [round(coords[0], DECIMALS), round(coords[1], DECIMALS)]
    return [rounded(c) for c in coords]


def main():
    desa = gpd.read_file(SOURCE).to_crs("EPSG:4326")
    desa = desa[desa["KDPKAB"] == "11.16"].copy()
    desa["geometry"] = desa.geometry.simplify(SIMPLIFY_DEGREES, preserve_topology=True).buffer(0)
    features = []
    for _, row in desa.sort_values("KDEPUM").iterrows():
        geometry = mapping(row.geometry)
        # A point always inside the desa (unlike a centroid), for its map label.
        label = row.geometry.representative_point()
        features.append({
            "type": "Feature",
            "properties": {
                "code": row["KDEPUM"],
                "name": row["WADMKD"],
                "kecamatan": row["WADMKC"],
                "kecamatanCode": row["KDCPUM"],
                "status": row["Status"],
                "persiapan": "Kampung persiapan" in str(row["REMARK"]),
                "label": [round(label.x, DECIMALS), round(label.y, DECIMALS)],
            },
            "geometry": {"type": geometry["type"], "coordinates": rounded(geometry["coordinates"])},
        })
    OUT.write_text(
        '{"type":"FeatureCollection","features":[\n' + ",\n".join(json.dumps(f, ensure_ascii=False, separators=(",", ":")) for f in features) + "\n]}\n",
        encoding="utf-8",
    )
    per_kecamatan = desa.groupby("WADMKC").size().to_dict()
    print(f"{len(features)} desa written to {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1e6:.2f} MB)")
    print(", ".join(f"{k} {v}" for k, v in sorted(per_kecamatan.items())))
    print("Boundary status:", desa["Status"].value_counts().to_dict())


if __name__ == "__main__":
    main()
