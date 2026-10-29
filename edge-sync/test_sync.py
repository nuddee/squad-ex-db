"""Unit tests for edge-sync/sync.py (run via `pnpm test` or `python edge-sync/test_sync.py`)."""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sync  # noqa: E402


def _ok_resp(batch_id: str = "b-1", received: int = 1) -> dict:
    return {
        "batch_id": batch_id,
        "received": received,
        "accepted": received,
        "skipped": 0,
        "skip_reasons": {},
        "skipped_samples": [],
        "duplicates_in_request": 0,
        "weight": {"weight_warning": False, "message": None},
        "warnings": [],
    }


class EdgeSyncTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def _cfg(self, url: str = "https://example.test") -> sync.Config:
        cfg = sync.Config()
        cfg.api_url = url
        cfg.key = "agv_test"
        cfg.root = str(self.root)
        cfg.state_path = self.root / "state.json"
        return cfg

    def test_resolve_results_root_precedence(self) -> None:
        cfg_dir = self.root / "cfg"
        cfg_dir.mkdir()
        (cfg_dir / "config.json").write_text(json.dumps({"results_dir": "/from/config"}), encoding="utf-8")

        with mock.patch.dict(os.environ, {"AGRIVISION_RESULTS_DIR": "/from/env"}, clear=False):
            self.assertEqual(sync.resolve_results_root(cfg_dir), "/from/env")

        with mock.patch.dict(os.environ, {"AGRIVISION_RESULTS_DIR": ""}, clear=False):
            self.assertEqual(sync.resolve_results_root(cfg_dir), "/from/config")

        empty_dir = self.root / "empty"
        empty_dir.mkdir()
        with mock.patch.dict(os.environ, {"AGRIVISION_RESULTS_DIR": "", "AGRIVISION_CONFIG": str(empty_dir / "nope.json")}, clear=False):
            with mock.patch("pathlib.Path.cwd", return_value=empty_dir):
                default = sync.resolve_results_root(empty_dir)
                self.assertTrue(default.endswith(os.path.join("Desktop", "Results")))

    # --- Issue 7: Refuse non-https AGRIVISION_API_URL except localhost ---
    def test_validate_requires_https_except_localhost(self) -> None:
        self._cfg("https://agrivision.example.com").validate()
        self._cfg("http://localhost:3000").validate()
        self._cfg("http://127.0.0.1:3000").validate()
        self._cfg("http://[::1]:3000").validate()

        with self.assertRaises(SystemExit):
            self._cfg("http://agrivision.example.com").validate()
        with self.assertRaises(SystemExit):
            self._cfg("http://192.168.1.50:3000").validate()
        with self.assertRaises(SystemExit):
            self._cfg("ftp://localhost:3000").validate()

        bad_win_cfg = self._cfg("http://localhost:3000")
        bad_win_cfg.root = "C:\tmp\agv-test"  # \t (tab) + \a (bell)
        with self.assertRaises(SystemExit) as cm:
            bad_win_cfg.validate()
        self.assertIn("control characters", str(cm.exception))

    # --- Issue 1: offset == 0 always treats row 0 as header even if fstate["header"] is already set ---
    def test_first_post_fails_then_retry_does_not_send_header_as_data_row(self) -> None:
        csv_path = self.root / "grain_123_rolling10s.csv"
        csv_path.write_text(
            "snapshot_time,snapshot_total\n"
            "2026-10-28 10:00:01,100\n"
            "2026-10-28 10:00:02,200\n",
            encoding="utf-8",
        )
        cfg = self._cfg()
        state = sync.load_state(cfg.state_path)

        # First attempt fails with NetworkError: fstate["header"] was set in memory, offset is still 0
        with mock.patch.object(sync, "post_rows", side_effect=sync.NetworkError("offline")):
            with self.assertRaises(sync.NetworkError):
                sync.sync_csv(cfg, state, csv_path)

        self.assertEqual(state["files"][str(csv_path)]["offset"], 0)
        self.assertEqual(state["files"][str(csv_path)]["header"], ["snapshot_time", "snapshot_total"])

        # Second attempt succeeds: must NOT send the header line as a data row, and first_record must be 1
        sent_calls: list[tuple[list[str], list[list[str]], int]] = []

        def fake_post(_c: sync.Config, _src: str, hdr: list[str], rows: list[list[str]], first_rec: int) -> dict:
            sent_calls.append((hdr, rows, first_rec))
            return _ok_resp(received=len(rows))

        with mock.patch.object(sync, "post_rows", side_effect=fake_post):
            sync.sync_csv(cfg, state, csv_path)

        self.assertEqual(len(sent_calls), 1)
        hdr, rows, first_rec = sent_calls[0]
        self.assertEqual(hdr, ["snapshot_time", "snapshot_total"])
        self.assertEqual(rows, [["2026-10-28 10:00:01", "100"], ["2026-10-28 10:00:02", "200"]])
        self.assertEqual(first_rec, 1)
        self.assertEqual(state["files"][str(csv_path)]["records_sent"], 2)

    # --- Issue 2: 1,200-row backlog where chunk 2 fails then recovers -> records_sent == 1200 ---
    def test_backlog_1200_rows_chunk2_fails_then_recovers_without_inflating_records_sent(self) -> None:
        csv_path = self.root / "grain_backlog_rolling10s.csv"
        lines = ["snapshot_time,snapshot_total"]
        for i in range(1, 1201):
            lines.append(f"2026-10-28 10:{(i // 60) % 60:02d}:{i % 60:02d},{i}")
        csv_path.write_text("\n".join(lines) + "\n", encoding="utf-8")

        cfg = self._cfg()
        state = sync.load_state(cfg.state_path)
        calls: list[tuple[int, int, str]] = []  # (first_record, len(rows), rows[0][1])

        def flaky_post(_c: sync.Config, _src: str, _hdr: list[str], rows: list[list[str]], first_rec: int) -> dict:
            calls.append((first_rec, len(rows), rows[0][1]))
            if len(calls) == 2:
                raise sync.NetworkError("dropped on chunk 2")
            return _ok_resp(received=len(rows))

        with mock.patch.object(sync, "post_rows", side_effect=flaky_post):
            # Pass 1: chunk 1 (1..500) succeeds, chunk 2 (501..1000) raises NetworkError
            with self.assertRaises(sync.NetworkError):
                sync.sync_csv(cfg, state, csv_path)
            self.assertEqual(state["files"][str(csv_path)]["records_sent"], 500)
            self.assertGreater(state["files"][str(csv_path)]["offset"], 0)

            # Pass 2: resumes at record 501 (chunk 2: 501..1000, chunk 3: 1001..1200)
            sync.sync_csv(cfg, state, csv_path)

        fstate = state["files"][str(csv_path)]
        self.assertEqual(fstate["records_sent"], 1200)
        self.assertEqual(fstate["offset"], csv_path.stat().st_size)
        self.assertEqual(
            calls,
            [
                (1, 500, "1"),       # pass 1, chunk 1 (ok)
                (501, 500, "501"),   # pass 1, chunk 2 (failed)
                (501, 500, "501"),   # pass 2, chunk 1 (retry of 501..1000, ok)
                (1001, 200, "1001"), # pass 2, chunk 2 (1001..1200, ok)
            ],
        )

    # --- Round-2 Item 1: Replaced CSV with IDENTICAL header, different first data row, and LARGER size ---
    def test_detects_replaced_csv_with_same_header_different_first_data_row_and_larger_size(self) -> None:
        csv_path = self.root / "grain_replace_rolling10s.csv"
        header_line = "snapshot_time,truck_plate,qc_name,snapshot_total\n"
        csv_path.write_text(
            header_line + "2026-10-28 10:00:01,TRUCK-OLD,InspectorA,100\n",
            encoding="utf-8",
        )
        cfg = self._cfg()
        state = sync.load_state(cfg.state_path)

        with mock.patch.object(sync, "post_rows", return_value=_ok_resp(received=1)):
            sync.sync_csv(cfg, state, csv_path)

        old_size = csv_path.stat().st_size
        old_hash = state["files"][str(csv_path)]["first_record_hash"]
        self.assertIsNotNone(old_hash)
        self.assertEqual(state["files"][str(csv_path)]["records_sent"], 1)

        # Replace file: IDENTICAL header line, DIFFERENT first data row, and LARGER total size
        csv_path.write_text(
            header_line
            + "2026-10-28 11:00:01,TRUCK-NEW,Somchai,250\n"
            + "2026-10-28 11:00:02,TRUCK-NEW,Somchai,300\n",
            encoding="utf-8",
        )
        self.assertGreater(csv_path.stat().st_size, old_size)

        captured: list[tuple[list[str], list[list[str]], int]] = []
        with mock.patch.object(
            sync,
            "post_rows",
            side_effect=lambda _c, _s, h, r, fr: (captured.append((h, r, fr)) or _ok_resp(received=len(r))),
        ):
            sync.sync_csv(cfg, state, csv_path)

        self.assertEqual(len(captured), 1)
        hdr, rows, first_rec = captured[0]
        self.assertEqual(hdr, ["snapshot_time", "truck_plate", "qc_name", "snapshot_total"])
        self.assertEqual(
            rows,
            [
                ["2026-10-28 11:00:01", "TRUCK-NEW", "Somchai", "250"],
                ["2026-10-28 11:00:02", "TRUCK-NEW", "Somchai", "300"],
            ],
        )
        self.assertEqual(first_rec, 1)
        self.assertEqual(state["files"][str(csv_path)]["records_sent"], 2)
        self.assertNotEqual(state["files"][str(csv_path)]["first_record_hash"], old_hash)

    # --- Round-2 Item 4: Python >= 3.8 startup check ---
    def test_check_python_version_requires_3_8_or_newer(self) -> None:
        sync.check_python_version((3, 8, 0))
        sync.check_python_version((3, 12, 1))
        with self.assertRaises(SystemExit) as cm:
            sync.check_python_version((3, 7, 9))
        self.assertIn("3.8", str(cm.exception))

    def test_read_new_records_tails_partial_lines_and_handles_truncation(self) -> None:
        csv_path = self.root / "grain_123_rolling10s.csv"
        csv_path.write_text("snapshot_time,snapshot_total\n2026-10-28 10:00:01,100\n2026-10-28 10:00:02,200", encoding="utf-8")
        fstate: dict = {"offset": 0, "header": None, "records_sent": 0}

        header, rows, new_off, _ = sync.read_new_records(csv_path, fstate)
        self.assertEqual(header, ["snapshot_time", "snapshot_total"])
        self.assertEqual(rows, [["2026-10-28 10:00:01", "100"]])  # trailing partial line held back
        fstate["header"] = header
        fstate["offset"] = new_off

        with open(csv_path, "a", encoding="utf-8") as f:
            f.write("\n2026-10-28 10:00:03,300\n")
        header2, rows2, new_off2, _ = sync.read_new_records(csv_path, fstate)
        self.assertEqual(header2, ["snapshot_time", "snapshot_total"])
        self.assertEqual(rows2, [["2026-10-28 10:00:02", "200"], ["2026-10-28 10:00:03", "300"]])
        fstate["offset"] = new_off2

        # File truncated/rewritten -> resets offset to 0
        csv_path.write_text("snapshot_time,snapshot_total\n2026-10-28 11:00:00,50\n", encoding="utf-8")
        header3, rows3, _, _ = sync.read_new_records(csv_path, fstate)
        self.assertEqual(header3, ["snapshot_time", "snapshot_total"])
        self.assertEqual(rows3, [["2026-10-28 11:00:00", "50"]])

    def test_sync_csv_logs_skips_and_weight_warning_and_persists_state(self) -> None:
        csv_path = self.root / "grain_nj2_rolling10s.csv"
        csv_path.write_text(
            "snapshot_time,snapshot_total,estimated_grain_count\n"
            "2026-10-28 10:00:01,100,22292\n"
            "bad-ts,100,100\n",
            encoding="utf-8",
        )
        cfg = self._cfg()
        state = sync.load_state(cfg.state_path)

        fake_resp = {
            "batch_id": "b-1",
            "received": 2,
            "accepted": 1,
            "skipped": 1,
            "skip_reasons": {"bad_timestamp": 1},
            "skipped_samples": [{"record": 2, "reason": "bad_timestamp"}],
            "duplicates_in_request": 0,
            "weight": {"weight_warning": True, "message": "WEIGHT WARNING: estimated good weight exceeds 500 g"},
            "warnings": ["WEIGHT WARNING: estimated good weight exceeds 500 g"],
        }
        with mock.patch.object(sync, "http_json", return_value=fake_resp) as m_post, self.assertLogs("edge-sync", level="INFO") as cm:
            sync.sync_csv(cfg, state, csv_path)

        m_post.assert_called_once()
        payload = m_post.call_args[0][2]
        self.assertEqual(payload["first_record"], 1)
        self.assertEqual(len(payload["rows"]), 2)
        joined = "\n".join(cm.output)
        self.assertIn("SKIPPED 1 row(s)", joined)
        self.assertIn("#2(bad_timestamp)", joined)
        self.assertIn("WEIGHT WARNING", joined)

        saved = sync.load_state(cfg.state_path)
        self.assertEqual(saved["files"][str(csv_path)]["records_sent"], 2)

    # --- Issues 3 & 6: Isolate errors per file/image, 400/413/422 during PUT -> snapshots_rejected, save state once per batch ---
    def test_snapshot_put_413_rejected_and_other_images_and_csvs_continue_with_single_batch_save(self) -> None:
        if sync.Image is None:
            self.skipTest("Pillow not available")

        dir1 = self.root / "b1"
        dir2 = self.root / "b2"
        (dir1 / "snapshots").mkdir(parents=True)
        (dir2 / "snapshots").mkdir(parents=True)

        csv1 = dir1 / "grain_a_rolling10s.csv"
        csv2 = dir2 / "grain_b_rolling10s.csv"
        csv1.write_text("snapshot_time,snapshot_total\n2026-10-28 10:00:01,100\n", encoding="utf-8")
        csv2.write_text("snapshot_time,snapshot_total\n2026-10-28 10:00:02,200\n", encoding="utf-8")

        old_time = time.time() - 10
        os.utime(csv1, (old_time - 5, old_time - 5))
        os.utime(csv2, (old_time, old_time))

        for p in [
            dir1 / "snapshots" / "20261028_100001_A_plate1.jpg",
            dir1 / "snapshots" / "20261028_100002_A_plate1.jpg",
            dir2 / "snapshots" / "20261028_100003_B_plate1.jpg",
        ]:
            sync.Image.new("RGB", (960, 540), color=(20, 120, 40)).save(p, "JPEG")
            os.utime(p, (old_time, old_time))

        cfg = self._cfg()
        state = sync.load_state(cfg.state_path)

        def fake_http_json(_c: sync.Config, path: str, payload: dict) -> dict:
            if path == "/api/ingest/rows":
                return _ok_resp(received=len(payload["rows"]))
            signed = [
                {
                    "filename": f["filename"],
                    "image": {"path": f["filename"], "token": "t", "signed_url": f"https://upload.test/{f['filename']}"},
                    "thumb": None,
                }
                for f in payload["files"]
            ]
            return {"batch_id": "b-1", "received": len(signed), "signed": signed, "rejected": [], "skipped": 0, "skip_reasons": {}}

        def fake_put(url: str, _data: bytes, _ct: str, _to: float) -> None:
            if url.endswith("20261028_100001_A_plate1.jpg"):
                raise sync.HttpError(413, "Payload Too Large")

        with mock.patch.object(sync, "http_json", side_effect=fake_http_json), \
             mock.patch.object(sync, "http_put", side_effect=fake_put), \
             mock.patch.object(sync, "save_state", wraps=sync.save_state) as m_save:
            # 413 on one image is permanently rejected; no transient failure occurred so run_pass does NOT raise/backoff
            sync.run_pass(cfg, state)

        self.assertEqual(state["files"][str(csv1)]["snapshots_rejected"], ["20261028_100001_A_plate1.jpg"])
        self.assertEqual(state["files"][str(csv1)]["snapshots_done"], ["20261028_100002_A_plate1.jpg"])
        self.assertEqual(state["files"][str(csv2)]["snapshots_done"], ["20261028_100003_B_plate1.jpg"])
        # 1 save for csv1 rows + 1 save for csv1 snapshot batch + 1 save for csv2 rows + 1 save for csv2 snapshot batch = 4
        self.assertEqual(m_save.call_count, 4)

    def test_one_csv_failing_with_503_tracks_per_file_next_retry_at_while_healthy_csv_syncs_every_interval(self) -> None:
        csv_bad = self.root / "grain_fail_rolling10s.csv"
        csv_good = self.root / "grain_ok_rolling10s.csv"
        csv_bad.write_text("snapshot_time,snapshot_total\n2026-10-28 10:00:01,100\n", encoding="utf-8")
        csv_good.write_text("snapshot_time,snapshot_total\n2026-10-28 10:00:01,200\n", encoding="utf-8")
        old_time = time.time() - 30
        os.utime(csv_bad, (old_time - 5, old_time - 5))
        os.utime(csv_good, (old_time, old_time))

        cfg = self._cfg()
        cfg.interval = 5.0
        state = sync.load_state(cfg.state_path)

        bad_should_fail = True
        calls: list[tuple[float, str, int]] = []
        current_now = 1000.0

        def fake_post(_c: sync.Config, src: str, _h: list[str], rows: list[list[str]], _fr: int) -> dict:
            calls.append((current_now, src, len(rows)))
            if src == csv_bad.name and bad_should_fail:
                raise sync.HttpError(503, "Service Unavailable")
            return _ok_resp(received=len(rows))

        with mock.patch.object(sync, "post_rows", side_effect=fake_post), \
             mock.patch("random.uniform", return_value=1.0):
            # Pass 1 at t=1000: csv_bad fails with 503 (next_retry_at = 1000 + 5 * 2^1 = 1010), csv_good syncs row 1
            failures_p1 = sync.run_pass(cfg, state, now=current_now)
            self.assertEqual(failures_p1, 1)
            self.assertEqual(state["files"][str(csv_bad)]["records_sent"], 0)
            self.assertEqual(state["files"][str(csv_bad)]["failures"], 1)
            self.assertEqual(state["files"][str(csv_bad)]["next_retry_at"], 1010.0)
            self.assertEqual(state["files"][str(csv_good)]["records_sent"], 1)
            self.assertEqual(state["files"][str(csv_good)]["next_retry_at"], 0.0)

            # Verify next_retry_at was persisted to state.json
            persisted = sync.load_state(cfg.state_path)
            self.assertEqual(persisted["files"][str(csv_bad)]["next_retry_at"], 1010.0)

            # Pass 2 at t=1005 (next normal 5s poll interval):
            # Append row 2 to csv_good. csv_bad is still in backoff (< 1010.0) so it is NOT retried yet,
            # while csv_good syncs row 2 immediately on the normal 5s schedule!
            current_now = 1005.0
            with open(csv_good, "a", encoding="utf-8") as f:
                f.write("2026-10-28 10:00:06,210\n")
            failures_p2 = sync.run_pass(cfg, state, now=current_now)
            self.assertEqual(failures_p2, 0)
            self.assertEqual(state["files"][str(csv_good)]["records_sent"], 2)
            self.assertEqual(state["files"][str(csv_bad)]["records_sent"], 0)

            # Pass 3 at t=1010 (next normal 5s poll interval, backoff for csv_bad has now expired):
            # Append row 3 to csv_good, and allow csv_bad to recover. Both sync!
            current_now = 1010.0
            bad_should_fail = False
            with open(csv_good, "a", encoding="utf-8") as f:
                f.write("2026-10-28 10:00:11,220\n")
            failures_p3 = sync.run_pass(cfg, state, now=current_now)
            self.assertEqual(failures_p3, 0)
            self.assertEqual(state["files"][str(csv_good)]["records_sent"], 3)
            self.assertEqual(state["files"][str(csv_bad)]["records_sent"], 1)
            self.assertEqual(state["files"][str(csv_bad)]["failures"], 0)
            self.assertEqual(state["files"][str(csv_bad)]["next_retry_at"], 0.0)

        self.assertEqual(
            calls,
            [
                (1000.0, csv_bad.name, 1),   # t=1000: csv_bad failed (503)
                (1000.0, csv_good.name, 1),  # t=1000: csv_good synced row 1
                (1005.0, csv_good.name, 1),  # t=1005: csv_bad skipped (backoff), csv_good synced row 2
                (1010.0, csv_bad.name, 1),   # t=1010: csv_bad retried & recovered
                (1010.0, csv_good.name, 1),  # t=1010: csv_good synced row 3
            ],
        )

    def test_auth_401_403_enters_cooldown_and_does_not_retry_hot(self) -> None:
        csv1 = self.root / "grain_auth1_rolling10s.csv"
        csv2 = self.root / "grain_auth2_rolling10s.csv"
        csv1.write_text("snapshot_time,snapshot_total\n2026-10-28 10:00:01,100\n", encoding="utf-8")
        csv2.write_text("snapshot_time,snapshot_total\n2026-10-28 10:00:02,200\n", encoding="utf-8")

        cfg = self._cfg()
        cfg.auth_cooldown_s = 900.0
        state = sync.load_state(cfg.state_path)

        calls: list[str] = []

        def fake_post(_c: sync.Config, src: str, _h: list[str], _r: list[list[str]], _fr: int) -> dict:
            calls.append(src)
            raise sync.HttpError(401, '{"error":"unauthorized"}')

        with mock.patch.object(sync, "post_rows", side_effect=fake_post), \
             self.assertLogs("edge-sync", level="ERROR") as cm:
            # Pass 1 at t=2000: csv1 gets 401 -> sets auth_backoff_until=2900 and stops pass immediately
            f1 = sync.run_pass(cfg, state, now=2000.0)
            self.assertEqual(f1, 1)
            self.assertEqual(calls, [csv1.name])
            self.assertEqual(state.get("auth_backoff_until"), 2900.0)

            # Pass 2 at t=2005 (5s later): still in auth cooldown -> 0 HTTP calls made
            f2 = sync.run_pass(cfg, state, now=2005.0)
            self.assertEqual(f2, 1)
            self.assertEqual(calls, [csv1.name])

        self.assertIn("AUTH ERROR", "\n".join(cm.output))
        # Local CSV files are intact
        self.assertTrue(csv1.exists())
        self.assertTrue(csv2.exists())

    def test_state_backup_recovery_and_disk_full_resilience(self) -> None:
        cfg = self._cfg()
        initial_state = {"files": {"grain_a.csv": {"offset": 128, "records_sent": 3}}}
        self.assertTrue(sync.save_state(cfg.state_path, initial_state))

        # Second save updates state.json and writes previous state to state.json.bak
        updated_state = {"files": {"grain_a.csv": {"offset": 256, "records_sent": 6}}}
        self.assertTrue(sync.save_state(cfg.state_path, updated_state))
        bak_path = cfg.state_path.with_name(cfg.state_path.name + ".bak")
        self.assertTrue(bak_path.exists())

        # Corrupt primary state.json -> load_state recovers from state.json.bak
        cfg.state_path.write_text("{corrupted-json", encoding="utf-8")
        recovered = sync.load_state(cfg.state_path)
        self.assertEqual(recovered["files"]["grain_a.csv"]["offset"], 128)

        # Simulate disk full (ENOSPC) during save_state -> returns False, does not crash, keeps existing file
        self.assertTrue(sync.save_state(cfg.state_path, updated_state))
        with mock.patch("builtins.open", side_effect=OSError(28, "No space left on device")):
            ok = sync.save_state(cfg.state_path, {"files": {"grain_a.csv": {"offset": 999}}})
        self.assertFalse(ok)
        with open(cfg.state_path, "r", encoding="utf-8") as f:
            still_intact = json.load(f)
        self.assertEqual(still_intact["files"]["grain_a.csv"]["offset"], 256)

    def test_bounded_backoff_for_multi_hour_network_outage(self) -> None:
        with mock.patch("random.uniform", return_value=1.0):
            # Even after 500 consecutive failures (hours offline), delay is capped at MAX_BACKOFF_S (300s)
            self.assertEqual(sync.compute_backoff_delay(5.0, 500), 300.0)


if __name__ == "__main__":
    unittest.main()
