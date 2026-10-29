"""Generate parity/fixtures/synthetic_5plates.csv (SYNTHETIC, not real device data).

Naive Bangkok wall-clock timestamps, estimated_grain_count present (shf-core v2.4+ format),
5 plates x 60 rows = 300 rows (> 200, so the legacy 200-row window drops plates), one
unknown class ("broken"), mixed last_frame / plate_end / mid_frame rows. Deterministic.
"""
import csv
import random
from datetime import datetime, timedelta
from pathlib import Path

random.seed(20261028)
out = Path(__file__).parent / "fixtures" / "synthetic_5plates.csv"
cols = ["snapshot_time", "plate_number", "snapshot_type", "snapshot_mix_summary",
        "truck_plate", "qc_name", "estimated_grain_count", "snapshot_total"]
t = datetime(2026, 10, 28, 9, 0, 0)
with out.open("w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(cols)
    for plate in range(1, 6):
        base_defect = 0.05 + 0.04 * plate  # plates drift 9%..25% so variance is high
        for i in range(60):
            n = random.randint(900, 1200)
            imm = int(n * base_defect * 0.5 * random.uniform(0.8, 1.2))
            sm = int(n * base_defect * 0.2 * random.uniform(0.8, 1.2))
            dc = int(n * base_defect * 0.2 * random.uniform(0.8, 1.2))
            br = int(n * base_defect * 0.1 * random.uniform(0.8, 1.2))
            good = n - imm - sm - dc - br
            parts = [("good", good), ("immature", imm), ("sm", sm), ("dc", dc), ("broken", br)]
            mix = ", ".join(f"{k}={v} ({v / n * 100:.1f}%)" for k, v in parts)
            typ = "plate_end" if i == 59 else ("mid_frame" if i % 17 == 5 else "last_frame")
            est = random.randint(780, 820) * 1 if plate != 4 else 0  # plate 4 has no estimates
            w.writerow([t.strftime("%Y-%m-%d %H:%M:%S"), plate, typ, mix, "1กข234", "Somchai", est, n])
            t += timedelta(seconds=10)
print("wrote", out)
