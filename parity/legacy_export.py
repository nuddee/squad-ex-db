"""Run the LEGACY compute_qc_metrics (x-26-10.py) on fixture CSVs and export JSON.

The legacy file is a Streamlit app (importing it would start the UI), so we parse it with `ast`
and exec only the pieces we need, unmodified: parse_mix_summary, load_csv, compute_qc_metrics,
SEED_WEIGHT_G, WEIGHT_VALUES_MEASURED, WEIGHT_SANITY_TOL, GOOD_SEED_WEIGHT_G, TOTAL_SAMPLE_WEIGHT_G, MODES.
Streamlit/reportlab are stubbed.

Usage: python legacy_export.py <legacy.py> <out.json> <csv> [<csv> ...]
"""
import ast
import json
import logging
import re
import sys
from collections import Counter
from types import SimpleNamespace

import pandas as pd

WINDOWS = [200, 0]  # 200 = legacy df.tail(200); 0 = all rows
NEEDED_FUNCS = {"parse_mix_summary", "load_csv", "compute_qc_metrics"}
NEEDED_ASSIGNS = {
    "WEIGHT_VALUES_MEASURED",
    "SEED_WEIGHT_G",
    "GOOD_SEED_WEIGHT_G",
    "TOTAL_SAMPLE_WEIGHT_G",
    "WEIGHT_SANITY_TOL",
    "MODES",
}


class _Any:
    """Absorbs attribute access / calls (stands in for reportlab colors)."""
    def __getattr__(self, _):
        return None


st_stub = SimpleNamespace(cache_data=lambda *a, **k: (lambda f: f))


def load_legacy(path):
    src = open(path, encoding="utf-8").read()
    tree = ast.parse(src)
    keep = []
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name in NEEDED_FUNCS:
            node.decorator_list = []  # drop @st.cache_data
            keep.append(node)
        elif isinstance(node, ast.Assign) and any(
            isinstance(t, ast.Name) and t.id in NEEDED_ASSIGNS for t in node.targets
        ):
            keep.append(node)
    ns = {"pd": pd, "re": re, "Counter": Counter, "logging": logging,
          "colors": _Any(), "_RESULTS_ROOT": "", "st": st_stub}
    exec(compile(ast.Module(body=keep, type_ignores=[]), path, "exec"), ns)
    # Apply the confirmed per-class seed weight defaults (immature = 0.20 g).
    ns["SEED_WEIGHT_G"] = {"good": 0.31, "immature": 0.20, "sm": 0.25, "dc": 0.30}
    ns["GOOD_SEED_WEIGHT_G"] = ns["SEED_WEIGHT_G"]["good"]
    # Disable the obsolete ±25% 500 g sanity warning by default (total_sample_weight_g = 0).
    ns["TOTAL_SAMPLE_WEIGHT_G"] = 0.0
    missing = (NEEDED_FUNCS | NEEDED_ASSIGNS) - ns.keys()
    if missing:
        raise SystemExit(f"legacy extraction failed, missing: {missing}")
    return ns


def clean(o):
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if hasattr(o, "item"):  # numpy scalar
        o = o.item()
    if isinstance(o, float) and o != o:
        return None
    if isinstance(o, pd.Timestamp):
        return o.isoformat()
    return o


def main():
    legacy_path, out_path, *csvs = sys.argv[1:]
    ns = load_legacy(legacy_path)
    mode = ns["MODES"]["grain"]
    result = {"legacy_file": legacy_path, "pandas": pd.__version__, "fixtures": {}}
    for csv in csvs:
        raw = pd.read_csv(csv, on_bad_lines="skip")
        tcol = "snapshot_time" if "snapshot_time" in raw.columns else "bin_end_ts"
        tz_aware = bool(raw[tcol].astype(str).str.contains(r"(?:Z|[+-]\d{2}:?\d{2})$", regex=True).any())
        df = ns["load_csv"](csv)
        entry = {
            "row_count": int(len(df)),
            "tz_aware": tz_aware,
            "first_time": df["snapshot_time"].iloc[0].isoformat() if len(df) else None,
            "last_time": df["snapshot_time"].iloc[-1].isoformat() if len(df) else None,
            "windows": {},
        }
        for win in WINDOWS:
            sub = df.tail(win).reset_index(drop=True) if win > 0 else df.reset_index(drop=True)
            summary, plate_df, _scan = ns["compute_qc_metrics"](sub, mode)
            plates = plate_df.to_dict("records") if len(plate_df) else []
            # UI alert formula (shf-db-v2-5.py:1833), threshold default 10.0
            defect_wt = summary.get("Total Defect % (wt)", 0.0) if summary else 0.0
            if summary:
                summary["is_defect_high"] = bool(defect_wt >= 10.0 and defect_wt > 0)
            entry["windows"][str(win)] = {"summary": clean(summary), "plates": clean(plates)}
        result["fixtures"][csv.replace("\\", "/").split("/")[-1]] = entry
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print("wrote", out_path)


if __name__ == "__main__":
    main()
