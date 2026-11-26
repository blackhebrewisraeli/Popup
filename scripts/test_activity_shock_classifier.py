"""Synthetic checks of scripts/activity_shock_classifier.py. No real market data is read.

Run from the repository root, in the pinned venv:

    .venv/bin/python -m unittest discover -s scripts -p 'test_activity_shock_classifier.py'
"""

from __future__ import annotations

import contextlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import activity_shock_classifier as asc
import expected_net_classifier as enc
import numpy as np
import quantile_forecast as qf

SPEC = json.loads((asc.ROOT / asc.SPEC_FILE).read_text(encoding="utf-8"))
STAGE_D = asc.load_stage_d(asc.ROOT, SPEC)
FEATURES = STAGE_D["features"]["candidate"]["order"]
CLASSES = STAGE_D["outcome"]["classes"]["order"]
H = 3_600_000
FIRST = qf.iso_ms("2024-11-22T00:00:00.000Z")
CUTOFF = qf.iso_ms("2026-11-22T00:00:00.000Z")
B1 = qf.iso_ms("2025-11-22T00:00:00.000Z")
B2 = qf.iso_ms("2026-05-22T00:00:00.000Z")
GRID = np.arange(FIRST, CUTOFF - qf.DAY_MS + 1, 4 * H)
COLUMNS = ["symbol", "time", "split", "stageDRow", "exclusion", *FEATURES, asc.ACTIVITY, "outcome", "class"]
HIGH, LOW, MID = (0.6, 0.2, 0.2), (0.2, 0.5, 0.3), (0.4, 0.35, 0.25)
AT = {name: COLUMNS.index(name) for name in COLUMNS}


def split_of(time: int) -> str | None:
    """protocol v1's splitOf: the 24-hour label inside one split, else purged."""
    end = time + qf.DAY_MS
    if end <= B1:
        return "train"
    if time >= B1 and end <= B2:
        return "validation"
    if time >= B2 and end <= CUTOFF:
        return "test"
    return None


def synthetic_rows(pairs: int = 3, activity_signal: bool = True, seed: int = 5) -> list:
    """v1's grid; with `activity_signal` the class follows the sign of the twelfth column only."""
    rng = np.random.default_rng(seed)
    rows: list = []
    for time in GRID:
        for pair in range(pairs):
            x = rng.normal(size=len(FEATURES)) * 0.01
            a = float(rng.normal())
            p = (HIGH if a > 0 else LOW) if activity_signal else MID
            klass = CLASSES[rng.choice(3, p=p)]
            rows.append([f"P{pair}USDT", int(time), split_of(int(time)), len(rows), None, *x.tolist(), a, klass, klass])
    return rows


def exclude(rows: list, where) -> list:
    """An activity exclusion: the row keeps its price features, loses activityShock24h."""
    out = [list(r) for r in rows]
    for r in out:
        if where(r):
            r[AT["exclusion"]] = "ACTIVITY_WINDOW_MISSING"
            r[AT[asc.ACTIVITY]] = None
    return out


def brier(rows: list, fitted: dict) -> float:
    p = np.array([r[1:] for r in fitted["rows"]])
    y = np.array([rows[r[0]][AT["class"]] for r in fitted["rows"]], dtype=object)
    onehot = np.stack([y == k for k in CLASSES], axis=1).astype(float)
    return float(((p - onehot) ** 2).sum(axis=1).mean())


def as_recorded(rows: list, fits: dict) -> dict:
    """A #222-shaped predictions file from arm A, indexed by #222 row, for the reproduction check."""
    evaluations = {}
    for eid, arms in fits.items():
        a = arms["A"]
        evaluations[eid] = {
            "status": a["status"],
            "fit": a["fit"],
            "rows": [[rows[r[0]][AT["stageDRow"]], *r[1:]] for r in a["rows"]],
        }
    return {"evaluations": evaluations, "environment": {"threadpools": []}}


class SpecificationTest(unittest.TestCase):
    def test_the_arms_are_220s_eleven_and_the_activity_column(self):
        arms = asc.arm_features(STAGE_D)
        self.assertEqual(arms["A"], qf.load_spec()["features"]["order"])
        self.assertEqual(arms["B"], [*arms["A"], "activityShock24h"])
        self.assertEqual(SPEC["estimator"]["settings"], STAGE_D["forecasters"]["C"]["settings"])
        self.assertEqual([e["id"] for e in SPEC["evaluations"]], ["development", "final"])
        self.assertEqual(SPEC["evaluations"], STAGE_D["periods"]["evaluations"])
        self.assertEqual(SPEC["dataSource"]["terms"]["status"], "RESOLVED")

    def test_222s_specification_is_hash_verified(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        (root / enc.SPEC_FILE).parent.mkdir(parents=True)
        (root / enc.SPEC_FILE).write_text((asc.ROOT / enc.SPEC_FILE).read_text(encoding="utf-8") + " ")
        with self.assertRaises(asc.IntegrityFailure):
            asc.load_stage_d(root, SPEC)
        spec = json.loads(json.dumps(SPEC))
        spec["estimator"]["settings"]["max_iter"] = 101
        with self.assertRaises(asc.IntegrityFailure):
            asc.load_stage_d(asc.ROOT, spec)


class CommonRowsTest(unittest.TestCase):
    def test_both_arms_drop_the_same_excluded_rows_and_keep_order(self):
        rows = exclude(synthetic_rows(pairs=1)[:50], lambda r: r[AT["time"]] % (8 * H) == 0)
        arms = asc.arm_features(STAGE_D)
        ia, xa, ya, sa = asc.common_arrays(COLUMNS, rows, arms["A"], CLASSES)
        ib, xb, yb, sb = asc.common_arrays(COLUMNS, rows, arms["B"], CLASSES)
        kept = [i for i, r in enumerate(rows) if r[AT["exclusion"]] is None]
        self.assertTrue(0 < len(kept) < 50)
        self.assertEqual(ia.tolist(), kept)
        self.assertEqual(ib.tolist(), kept)
        self.assertEqual((xa.shape, xb.shape), ((len(kept), 11), (len(kept), 12)))
        np.testing.assert_array_equal(xa, xb[:, :11])
        self.assertEqual(xb[0, 11], rows[kept[0]][AT[asc.ACTIVITY]])
        self.assertTrue(np.array_equal(ya, yb) and np.array_equal(sa, sb))

    def test_a_non_finite_or_unknown_value_is_refused(self):
        rows = synthetic_rows(pairs=1)[:10]
        bad = [list(r) for r in rows]
        bad[2][AT[asc.ACTIVITY]] = float("inf")
        with self.assertRaises(ValueError):
            asc.common_arrays(COLUMNS, bad, asc.arm_features(STAGE_D)["B"], CLASSES)
        bad = [list(r) for r in rows]
        bad[2][AT["class"]] = "AMBIGUOUS"
        with self.assertRaises(ValueError):
            asc.common_arrays(COLUMNS, bad, asc.arm_features(STAGE_D)["A"], CLASSES)


class ArmParityTest(unittest.TestCase):
    def test_arms_whose_labels_differ_are_refused_before_any_fit(self):
        rows = synthetic_rows(pairs=1)[:40]
        real = asc.common_arrays

        def skewed(columns, rows, features, classes):
            index, x, y, splits = real(columns, rows, features, classes)
            if asc.ACTIVITY in features:
                y = y.copy()
                y[0] = "TIMEOUT" if y[0] != "TIMEOUT" else "STOP"
            return index, x, y, splits

        with mock.patch.object(asc, "common_arrays", side_effect=skewed), mock.patch.object(enc, "fit_evaluation") as fit:
            with self.assertRaises(asc.IntegrityFailure):
                asc.fit_arms(COLUMNS, rows, SPEC, STAGE_D)
            fit.assert_not_called()


class FitTest(unittest.TestCase):
    # Row lists are compared as arrays: unittest's diff of thousands of rows is quadratic.
    @classmethod
    def setUpClass(cls):
        cls.rows = exclude(synthetic_rows(), lambda r: r[AT["symbol"]] == "P2USDT" and r[AT["time"]] % (12 * H) == 0)
        cls.fits = asc.fit_arms(COLUMNS, cls.rows, SPEC, STAGE_D)

    def test_four_fits_in_order_on_identical_common_rows_and_settings(self):
        self.assertEqual(list(self.fits), ["development", "final"])
        common = [i for i, r in enumerate(self.rows) if r[AT["exclusion"]] is None]
        for e in SPEC["evaluations"]:
            arms = self.fits[e["id"]]
            self.assertEqual(list(arms), ["A", "B"])
            expected_fit = sum(self.rows[i][AT["split"]] in e["fit"] for i in common)
            expected_rows = [i for i in common if self.rows[i][AT["split"]] == e["evaluate"]]
            for arm in ("A", "B"):
                f = arms[arm]
                self.assertEqual(f["status"], "FITTED")
                self.assertEqual(f["fit"]["observations"], expected_fit)
                self.assertEqual(f["fit"]["params"], enc.verified_params(STAGE_D))
                self.assertEqual(f["fit"]["features"], asc.arm_features(STAGE_D)[arm])
                np.testing.assert_array_equal([r[0] for r in f["rows"]], expected_rows)
                p = np.array([r[1:] for r in f["rows"]])
                np.testing.assert_allclose(p.sum(axis=1), 1, atol=1e-12)
            self.assertEqual(arms["A"]["fit"]["classes"], arms["B"]["fit"]["classes"])

    def test_arm_a_is_222s_fit_on_the_same_rows(self):
        common = [r for r in self.rows if r[AT["exclusion"]] is None]
        x = np.array([r[AT[FEATURES[0]] : AT[FEATURES[-1]] + 1] for r in common], dtype=np.float64)
        y = np.array([r[AT["class"]] for r in common], dtype=object)
        splits = np.array([r[AT["split"]] for r in common], dtype=object)
        direct = enc.fit_evaluation(x, y, splits, SPEC["evaluations"][1], STAGE_D)
        mine = np.array([r[1:] for r in self.fits["final"]["A"]["rows"]])
        np.testing.assert_array_equal(mine, np.array([r[1:] for r in direct["rows"]]))

    def test_outcomes_after_the_fit_set_cannot_change_a_fit(self):
        changed = [list(r) for r in self.rows]
        for r in changed:
            if r[AT["split"]] in ("test", None):
                r[AT["class"]] = "TARGET"
        again = asc.fit_arms(COLUMNS, changed, SPEC, STAGE_D)
        for eid in ("development", "final"):
            for arm in ("A", "B"):
                np.testing.assert_array_equal(again[eid][arm]["rows"], self.fits[eid][arm]["rows"])

    def test_a_missing_class_gives_no_fit_for_either_arm(self):
        rows = [list(r) for r in self.rows]
        for r in rows:
            if r[AT["split"]] == "train" and r[AT["class"]] == "TIMEOUT":
                r[AT["class"]] = "STOP"
        fits = asc.fit_arms(COLUMNS, rows, SPEC, STAGE_D)
        for arm in ("A", "B"):
            self.assertEqual(fits["development"][arm]["status"], "MISSING_CLASS")
            self.assertEqual(fits["development"][arm]["rows"], [])
            self.assertEqual(fits["final"][arm]["status"], "FITTED")


class ReproductionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows = synthetic_rows(pairs=2, seed=11)
        cls.fits = asc.fit_arms(COLUMNS, cls.rows, SPEC, STAGE_D)

    def test_pass_when_the_sets_equal_222s(self):
        report = asc.reproduction_of_c(COLUMNS, self.rows, SPEC, self.fits, as_recorded(self.rows, self.fits))
        for eid in ("development", "final"):
            self.assertEqual(report[eid]["status"], "PASS")
            self.assertEqual(report[eid]["maxAbsoluteDifference"], 0.0)

    def test_a_difference_above_the_tolerance_is_an_integrity_failure(self):
        recorded = as_recorded(self.rows, self.fits)
        recorded["evaluations"]["final"]["rows"][7][2] += 2e-12
        with self.assertRaises(asc.IntegrityFailure):
            asc.reproduction_of_c(COLUMNS, self.rows, SPEC, self.fits, recorded)
        recorded = as_recorded(self.rows, self.fits)
        recorded["evaluations"]["development"]["rows"].pop()
        with self.assertRaises(asc.IntegrityFailure):
            asc.reproduction_of_c(COLUMNS, self.rows, SPEC, self.fits, recorded)

    def test_a_different_fit_status_is_an_integrity_failure(self):
        recorded = as_recorded(self.rows, self.fits)
        recorded["evaluations"]["development"]["status"] = "MISSING_CLASS"
        with self.assertRaises(asc.IntegrityFailure):
            asc.reproduction_of_c(COLUMNS, self.rows, SPEC, self.fits, recorded)

    def test_not_applicable_when_activity_excludes_a_row(self):
        rows = exclude(self.rows, lambda r: r[AT["split"]] == "validation" and r[AT["symbol"]] == "P0USDT" and r[AT["time"]] % (24 * H) == 0)
        fits = asc.fit_arms(COLUMNS, rows, SPEC, STAGE_D)
        report = asc.reproduction_of_c(COLUMNS, rows, SPEC, fits, as_recorded(self.rows, self.fits))
        self.assertEqual(report["development"]["status"], "NOT_APPLICABLE")
        self.assertGreater(report["development"]["excluded"]["evaluated"], 0)
        self.assertEqual(report["final"]["status"], "NOT_APPLICABLE")  # validation is final's fit set
        self.assertGreater(report["final"]["excluded"]["fit"], 0)


class SyntheticStudyTest(unittest.TestCase):
    """Integration checks of the two arms, not evidence of financial skill."""

    def differences(self, rows: list) -> dict:
        fits = asc.fit_arms(COLUMNS, rows, SPEC, STAGE_D)
        return {eid: brier(rows, f["B"]) - brier(rows, f["A"]) for eid, f in fits.items()}

    def test_a_learnable_activity_column_lowers_brier(self):
        for difference in self.differences(synthetic_rows(activity_signal=True)).values():
            self.assertLess(difference, -0.05)

    def test_a_noise_activity_column_does_not(self):
        for difference in self.differences(synthetic_rows(activity_signal=False, seed=8)).values():
            self.assertGreater(difference, -0.002)


class RunnerTest(unittest.TestCase):
    def test_dataset_path_needs_exactly_one_dataset_of_the_commit(self):
        out = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, out)
        with self.assertRaises(FileNotFoundError):
            asc.dataset_path(out, "c" * 40)
        for spec12 in ("a" * 12, "b" * 12):
            (out / f"{asc.PREFIX}-dataset-{spec12}-{'c' * 12}.json").write_text("{}")
        with self.assertRaises(FileNotFoundError):
            asc.dataset_path(out, "c" * 40)

    def test_identity_refuses_a_dirty_tree(self):
        with self.assertRaises(RuntimeError):
            asc.code_identity(lambda *args: " M scripts/x.py" if args[0] == "status" else "abc")
        clean = asc.code_identity(lambda *args: "" if args[0] == "status" else "abc")
        self.assertEqual(clean["codeBlobs"], dict.fromkeys(asc.CODE_FILES, "abc"))

    def test_main_checks_reproduction_writes_once_and_never_overwrites(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        rows = synthetic_rows(pairs=1, seed=3)
        recorded = as_recorded(rows, asc.fit_arms(COLUMNS, rows, SPEC, STAGE_D))
        recorded_path = "fixtures/recorded-predictions.json"
        (root / recorded_path).parent.mkdir(parents=True)
        (root / recorded_path).write_text(json.dumps(recorded))
        spec = json.loads(json.dumps(SPEC))
        spec["basis"]["estimatorSource"]["predictions"] = {
            "path": recorded_path,
            "sha256": qf.sha256((root / recorded_path).read_bytes()),
        }
        for name in (enc.SPEC_FILE, asc.REQUIREMENTS_FILE):
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(asc.ROOT / name, root / name)
        (root / asc.SPEC_FILE).write_text(json.dumps(spec))
        commit = "c" * 40
        out = root / asc.OUTPUT_DIR
        out.mkdir()
        manifest = {
            "codeCommit": commit,
            "specification": {
                "id": SPEC["specificationId"],
                "sha256": "a" * 64,
                "fileSha256": qf.sha256((root / asc.SPEC_FILE).read_bytes()),
            },
        }
        path = out / f"{asc.PREFIX}-dataset-{'a' * 12}-{commit[:12]}.json"
        path.write_text(json.dumps({"manifest": manifest, "columns": COLUMNS, "rows": rows}))
        pins = qf.pinned_versions((root / asc.REQUIREMENTS_FILE).read_text(encoding="utf-8"))

        def run(git_commit: str = commit):
            git = lambda *args: "" if args[0] == "status" else git_commit  # noqa: E731
            with contextlib.redirect_stdout(io.StringIO()) as printed:
                code = asc.main(root, git, pins.get)
            return code, json.loads(printed.getvalue())

        code, report = run()
        self.assertEqual((code, report["status"]), (0, "CREATED"))
        self.assertEqual(report["reproductionOfC"]["final"]["status"], "PASS")
        written = (root / report["path"]).read_bytes()
        self.assertEqual(qf.sha256(written), report["contentSha256"])
        result = json.loads(written)
        self.assertEqual(result["manifest"]["dataset"]["sha256"], qf.sha256(path.read_bytes()))
        self.assertEqual(list(result["evaluations"]["final"]), ["A", "B"])
        self.assertEqual(run()[1]["status"], "UNCHANGED")
        (root / report["path"]).write_text("other")
        code, report = run()
        self.assertEqual((code, report["status"]), (1, "CONFLICT"))
        self.assertEqual((root / report["path"]).read_text(), "other")

        (root / recorded_path).write_text(json.dumps(recorded) + " ")
        with self.assertRaises(asc.IntegrityFailure):
            run()
        (root / recorded_path).write_text(json.dumps(recorded))
        path.rename(out / f"{asc.PREFIX}-dataset-{'a' * 12}-{'d' * 12}.json")
        with self.assertRaises(ValueError):
            run("d" * 40)  # the dataset's manifest names another commit
        with self.assertRaises(RuntimeError):
            asc.main(root, lambda *a: "" if a[0] == "status" else commit, lambda name: "0.0")


if __name__ == "__main__":
    unittest.main()
