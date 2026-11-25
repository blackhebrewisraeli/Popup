"""Synthetic checks of scripts/expected_net_classifier.py. No real market data is read.

Run from the repository root, in the pinned venv:

    .venv/bin/python -m unittest discover -s scripts -p 'test_expected_net_classifier.py'
"""

from __future__ import annotations

import contextlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import expected_net_classifier as enc
import numpy as np
import quantile_forecast as qf
from sklearn.ensemble import HistGradientBoostingClassifier

SPEC = enc.load_spec()
FEATURES = SPEC["features"]["candidate"]["order"]
CLASSES = SPEC["outcome"]["classes"]["order"]
H = 3_600_000
FIRST = qf.iso_ms("2024-11-22T00:00:00.000Z")
CUTOFF = qf.iso_ms("2026-11-22T00:00:00.000Z")
B1 = qf.iso_ms("2025-11-22T00:00:00.000Z")
B2 = qf.iso_ms("2026-05-22T00:00:00.000Z")
GRID = np.arange(FIRST, CUTOFF - qf.DAY_MS + 1, 4 * H)
COLUMNS = [
    "symbol",
    "time",
    "split",
    *FEATURES,
    "cell",
    "v",
    "outcome",
    "class",
    "bar",
    "gross",
    "net",
    "overshootOutcome",
    "overshootBar",
    "overshootGross",
    "overshootNet",
    "orderingNet",
]
HIGH, LOW, MID = (0.6, 0.2, 0.2), (0.2, 0.5, 0.3), (0.4, 0.35, 0.25)


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


def synthetic_rows(pairs: int = 3, learnable: bool = True, seed: int = 5) -> list:
    """v1's grid; with `learnable` the class probabilities follow the sign of ret1h."""
    rng = np.random.default_rng(seed)
    rows = []
    for time in GRID:
        for pair in range(pairs):
            x = rng.normal(size=len(FEATURES)) * 0.01
            p = (HIGH if x[0] > 0 else LOW) if learnable else MID
            klass = CLASSES[rng.choice(3, p=p)]
            rows.append(
                [f"P{pair}USDT", int(time), split_of(int(time)), *x.tolist()]
                + ["mid/positive", 0.01, klass, klass, 24, 0.0, -0.003]
                + [klass, 24, 0.0, -0.003, -0.003]
            )
    return rows


def brier(probabilities: np.ndarray, y: np.ndarray) -> float:
    onehot = np.stack([y == k for k in CLASSES], axis=1).astype(float)
    return float(((probabilities - onehot) ** 2).sum(axis=1).mean())


def fitted(rows: list) -> dict:
    return enc.run_fits(COLUMNS, rows, SPEC)


class SpecificationTest(unittest.TestCase):
    def test_settings_match_the_verified_installed_api(self):
        params = HistGradientBoostingClassifier(**SPEC["forecasters"]["C"]["settings"]).get_params()
        self.assertEqual(params, enc.verified_params(SPEC))
        self.assertEqual(FEATURES, qf.load_spec()["features"]["order"])
        self.assertEqual(CLASSES, ["TARGET", "STOP", "TIMEOUT"])
        self.assertEqual(
            [e["id"] for e in SPEC["periods"]["evaluations"]], ["development", "final"]
        )


class DatasetTest(unittest.TestCase):
    def test_columns_are_read_by_name_and_refused_when_wrong(self):
        rows = synthetic_rows(pairs=1)[:10]
        x, y, splits = enc.dataset_arrays(COLUMNS, rows, SPEC)
        self.assertEqual(x.shape, (10, len(FEATURES)))
        self.assertEqual(x[0, 0], rows[0][3])
        self.assertEqual(splits[0], "train")
        with self.assertRaises(ValueError):
            enc.dataset_arrays([c for c in COLUMNS if c != "split"], rows, SPEC)
        bad = [list(r) for r in rows]
        bad[3][5] = float("nan")
        with self.assertRaises(ValueError):
            enc.dataset_arrays(COLUMNS, bad, SPEC)
        bad = [list(r) for r in rows]
        bad[0][COLUMNS.index("class")] = "AMBIGUOUS"
        with self.assertRaises(ValueError):
            enc.dataset_arrays(COLUMNS, bad, SPEC)


class FitTest(unittest.TestCase):
    # Row lists are compared as arrays: unittest's diff of thousands of rows is quadratic.
    @classmethod
    def setUpClass(cls):
        cls.rows = synthetic_rows()
        cls.result = fitted(cls.rows)

    def test_each_evaluation_fits_its_fit_splits_and_predicts_its_split_in_order(self):
        splits = [r[2] for r in self.rows]
        for e in SPEC["periods"]["evaluations"]:
            out = self.result[e["id"]]
            self.assertEqual(out["status"], "FITTED")
            self.assertEqual(out["fit"]["observations"], sum(s in e["fit"] for s in splits))
            expected = [i for i, s in enumerate(splits) if s == e["evaluate"]]
            np.testing.assert_array_equal([r[0] for r in out["rows"]], expected)
            p = np.array([r[1:] for r in out["rows"]])
            np.testing.assert_allclose(p.sum(axis=1), 1, atol=1e-12)
            self.assertEqual(out["fit"]["params"], enc.verified_params(SPEC))
            self.assertEqual(out["fit"]["nIter"], 100)
            self.assertEqual(out["fit"]["classes_"], ["STOP", "TARGET", "TIMEOUT"])

    def test_outcomes_after_the_fit_set_cannot_change_a_fit(self):
        changed = [list(r) for r in self.rows]
        at = COLUMNS.index("class")
        for r in changed:
            if r[2] in ("test", None):
                r[at] = "TARGET"
        again = fitted(changed)
        for eid in ("development", "final"):
            np.testing.assert_array_equal(again[eid]["rows"], self.result[eid]["rows"])
        for r in changed:
            if r[2] == "validation":
                r[at] = "TIMEOUT"
        third = fitted(changed)
        np.testing.assert_array_equal(
            third["development"]["rows"], self.result["development"]["rows"]
        )
        self.assertFalse(np.array_equal(third["final"]["rows"], self.result["final"]["rows"]))

    def test_probability_columns_follow_the_specification_order(self):
        out = self.result["final"]
        x = np.array([self.rows[r[0]][3] for r in out["rows"]])
        p = np.array([r[1:] for r in out["rows"]])
        self.assertGreater(p[x > 0, 0].mean(), 0.5)  # TARGET first
        self.assertGreater(p[x < 0, 1].mean(), 0.4)  # then STOP

    def test_a_missing_class_gives_no_fit(self):
        rows = [list(r) for r in self.rows]
        at = COLUMNS.index("class")
        for r in rows:
            if r[2] == "train" and r[at] == "TIMEOUT":
                r[at] = "STOP"
        result = fitted(rows)
        self.assertEqual(result["development"]["status"], "MISSING_CLASS")
        self.assertEqual(result["development"]["rows"], [])
        self.assertEqual(result["development"]["fit"]["classes"]["TIMEOUT"], 0)
        self.assertEqual(result["final"]["status"], "FITTED")

    def test_parameters_that_differ_from_the_specification_stop_the_fit(self):
        spec = json.loads(json.dumps(SPEC))
        spec["forecasters"]["C"]["verifiedParams"]["max_bins"] = 254
        with self.assertRaises(RuntimeError):
            enc.run_fits(COLUMNS, self.rows, spec)


class SyntheticStudyTest(unittest.TestCase):
    """An integration check of the fit, not evidence of financial skill."""

    def score(self, rows: list) -> dict:
        result = fitted(rows)
        y_all = np.array([r[COLUMNS.index("class")] for r in rows], dtype=object)
        scores = {}
        for e in SPEC["periods"]["evaluations"]:
            fit = result[e["id"]]["fit"]["classes"]
            base = np.array([fit[k] for k in CLASSES]) / sum(fit.values())
            index = [r[0] for r in result[e["id"]]["rows"]]
            p = np.array([r[1:] for r in result[e["id"]]["rows"]])
            y = y_all[index]
            scores[e["id"]] = brier(p, y) - brier(np.tile(base, (len(y), 1)), y)
        return scores

    def test_a_learnable_relationship_beats_the_unconditional_baseline(self):
        for difference in self.score(synthetic_rows(learnable=True)).values():
            self.assertLess(difference, -0.05)

    def test_unrelated_features_do_not_beat_it(self):
        for difference in self.score(synthetic_rows(learnable=False, seed=8)).values():
            self.assertGreater(difference, -0.002)


class RunnerTest(unittest.TestCase):
    def test_identity_refuses_a_dirty_tree(self):
        with self.assertRaises(RuntimeError):
            enc.code_identity(lambda *args: " M scripts/x.py" if args[0] == "status" else "abc")
        clean = enc.code_identity(lambda *args: "" if args[0] == "status" else "abc")
        self.assertEqual(clean["codeBlobs"], dict.fromkeys(enc.CODE_FILES, "abc"))

    def test_main_writes_once_and_never_overwrites(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        for name in (enc.SPEC_FILE, enc.REQUIREMENTS_FILE):
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(enc.ROOT / name, root / name)
        commit = "c" * 40
        out = root / enc.OUTPUT_DIR
        out.mkdir()
        with self.assertRaises(FileNotFoundError):
            enc.dataset_path(out, commit)
        manifest = {
            "codeCommit": commit,
            "specification": {
                "id": SPEC["specificationId"],
                "sha256": "a" * 64,
                "fileSha256": qf.sha256((root / enc.SPEC_FILE).read_bytes()),
            },
        }
        dataset = {"manifest": manifest, "columns": COLUMNS, "rows": synthetic_rows(pairs=1)}
        path = out / f"{enc.PREFIX}-dataset-{'a' * 12}-{commit[:12]}.json"
        path.write_text(json.dumps(dataset))
        pins = qf.pinned_versions((root / enc.REQUIREMENTS_FILE).read_text(encoding="utf-8"))

        def run(git_commit: str = commit):
            git = lambda *args: "" if args[0] == "status" else git_commit  # noqa: E731
            with contextlib.redirect_stdout(io.StringIO()) as printed:
                code = enc.main(root, git, pins.get)
            return code, json.loads(printed.getvalue())

        code, report = run()
        self.assertEqual((code, report["status"]), (0, "CREATED"))
        written = (root / report["path"]).read_bytes()
        self.assertEqual(qf.sha256(written), report["contentSha256"])
        result = json.loads(written)
        self.assertEqual(result["manifest"]["dataset"]["sha256"], qf.sha256(path.read_bytes()))
        self.assertEqual(result["manifest"]["specification"], manifest["specification"])
        self.assertEqual(report["evaluations"]["final"]["status"], "FITTED")
        self.assertEqual(run()[1]["status"], "UNCHANGED")
        (root / report["path"]).write_text("other")
        code, report = run()
        self.assertEqual((code, report["status"]), (1, "CONFLICT"))
        self.assertEqual((root / report["path"]).read_text(), "other")

        moved = out / f"{enc.PREFIX}-dataset-{'a' * 12}-{'d' * 12}.json"
        path.rename(moved)
        with self.assertRaises(ValueError):
            run("d" * 40)  # the dataset's manifest names another commit
        with self.assertRaises(RuntimeError):
            enc.main(root, lambda *a: "" if a[0] == "status" else commit, lambda name: "0.0")


if __name__ == "__main__":
    unittest.main()
