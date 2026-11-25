"""Synthetic checks of scripts/quantile_forecast.py. No real market data is read.

Run from the repository root, in the pinned venv:

    .venv/bin/python -m unittest discover -s scripts -p 'test_quantile_forecast.py'
"""

from __future__ import annotations

import contextlib
import io
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import numpy as np
import quantile_forecast as qf
from sklearn.ensemble import HistGradientBoostingRegressor

SPEC = qf.load_spec()
FEATURES = SPEC["features"]["order"]
ATR = FEATURES.index("atr14OverClose")
H = 3_600_000
FIRST = qf.iso_ms("2024-11-22T00:00:00.000Z")
CUTOFF = qf.iso_ms("2026-11-22T00:00:00.000Z")
B1 = qf.iso_ms("2025-11-22T00:00:00.000Z")
B2 = qf.iso_ms("2026-05-22T00:00:00.000Z")
GRID = np.arange(FIRST, CUTOFF - qf.DAY_MS + 1, 4 * H)


def synthetic_rows(pairs: int = 4, learnable: bool = True, seed: int = 5) -> list:
    """v1's grid with random features; with `learnable`, ret24h shifts and ret72h scales targets."""
    rng = np.random.default_rng(seed)
    rows = []
    for time in GRID:
        for pair in range(pairs):
            x = rng.normal(size=len(FEATURES)) * 0.01
            v = 0.005 + 0.02 * rng.random()
            x[ATR] = v
            z = rng.normal(size=3)
            if learnable:
                shift, scale = 2 * np.tanh(x[2] / 0.01), 1 + 2 * (x[3] > 0)
                labels = [
                    shift + scale * z[0],
                    scale * abs(z[1]) + max(shift, 0),
                    scale * abs(z[2]) + max(-shift, 0),
                ]
            else:
                labels = [z[0], abs(z[1]), abs(z[2])]
            rows.append([f"P{pair}USDT", int(time), *x.tolist(), *(np.array(labels) * v).tolist()])
    return rows


COLUMNS = ["symbol", "time", *FEATURES, *SPEC["model"]["targets"]]


class SpecificationTest(unittest.TestCase):
    def test_settings_match_the_verified_installed_api(self):
        settings = SPEC["model"]["settings"]
        params = HistGradientBoostingRegressor(quantile=0.1, **settings).get_params()
        verified = {k: v for k, v in SPEC["model"]["verifiedParams"].items() if k != "note"}
        self.assertEqual(params, verified)
        pins = qf.pinned_versions((qf.ROOT / qf.REQUIREMENTS_FILE).read_text(encoding="utf-8"))
        self.assertEqual(pins["scikit-learn"], SPEC["model"]["version"])
        for name, version in pins.items():
            self.assertIn(f"{name} {version}", SPEC["environment"]["requirements"])

    def test_constants_mirror_the_specification_text(self):
        self.assertIn(f"default_rng({qf.BOOTSTRAP_SEED})", SPEC["uncertainty"]["draws"])
        text = SPEC["interpretation"]["calibration"]["CALIBRATED"]
        self.assertIn(f"[{qf.COVERAGE_RANGE[0]}, {qf.COVERAGE_RANGE[1]}]", text)
        self.assertIn(f"[{qf.TAIL_RANGE[0]}, {qf.TAIL_RANGE[1]}]", text)
        self.assertEqual(
            [p["id"] for p in SPEC["periods"]["list"]], ["train", "validation", "final"]
        )


class PeriodTest(unittest.TestCase):
    def test_labels_crossing_a_boundary_are_purged(self):
        times = np.array(
            [FIRST, B1 - 24 * H, B1 - 20 * H, B1, B2 - 4 * H, B2, CUTOFF - 24 * H, CUTOFF - 20 * H]
        )
        self.assertEqual(qf.period_codes(times, SPEC).tolist(), [0, 0, -1, 1, -1, 2, 2, -1])
        purged = qf.purged_by_boundary(GRID, SPEC)
        self.assertEqual(
            purged,
            {
                "2025-11-22T00:00:00.000Z": 5,
                "2026-05-22T00:00:00.000Z": 5,
                "2026-11-22T00:00:00.000Z": 0,
            },
        )
        counts = np.bincount(qf.period_codes(GRID, SPEC) + 1)
        self.assertEqual(counts.tolist(), [10, 2185, 1081, 1099])


class FitTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows = synthetic_rows(pairs=2)
        cls.data = qf.dataset_arrays(COLUMNS, cls.rows, SPEC)
        cls.codes = qf.period_codes(cls.data.times, SPEC)
        cls.development = qf.fit_evaluation(cls.data, cls.codes, SPEC["evaluations"][0], SPEC)

    def refit(self, change) -> qf.Fitted:
        labels = self.data.labels.copy()
        change(labels)
        data = qf.Data(self.data.symbols, self.data.times, self.data.features, labels, self.data.v)
        return qf.fit_evaluation(data, self.codes, SPEC["evaluations"][0], SPEC)

    def test_the_baseline_uses_the_fitting_observations_only(self):
        train = self.codes == 0
        normalized = self.data.labels[train] / self.data.v[train][:, None]
        expected = [[np.quantile(normalized[:, t], q) for q in (0.1, 0.5, 0.9)] for t in range(3)]
        np.testing.assert_array_equal(self.development.baseline, np.array(expected))
        np.testing.assert_array_equal(self.development.fit_mask, train)

    def test_later_labels_cannot_alter_an_earlier_fit(self):
        def scramble_later(labels):
            labels[self.codes != 0] = labels[self.codes != 0][::-1] * 7

        later = self.refit(scramble_later)
        np.testing.assert_array_equal(later.baseline, self.development.baseline)
        np.testing.assert_array_equal(later.model, self.development.model)
        np.testing.assert_array_equal(later.reference, self.development.reference)

        def change_one_training_label(labels):
            labels[np.flatnonzero(self.codes == 0)[0], 0] = 1.0

        self.assertFalse(
            np.array_equal(self.refit(change_one_training_label).model, self.development.model)
        )

    def test_forecasts_are_normalized_predictions_times_v(self):
        class One:
            def predict(self, x):
                return np.ones(len(x))

        v = np.array([0.01, 0.02])
        forecasts = qf.model_forecasts([[One()] * 3] * 3, np.zeros((2, len(FEATURES))), v)
        np.testing.assert_array_equal(forecasts[:, 1, 2], v)
        np.testing.assert_array_equal(
            qf.baseline_forecasts(np.full((3, 3), 2.0), v)[:, 0, 0], 2 * v
        )
        mask = self.development.eval_mask
        estimator = self.development.models[0][1]
        normalized = estimator.predict(self.data.features[mask])
        np.testing.assert_array_equal(
            self.development.model[:, 0, 1], normalized * self.data.v[mask]
        )

    def test_a_non_finite_row_is_refused(self):
        bad = [list(r) for r in self.rows[:3]]
        bad[1][2 + ATR] = 0.0
        with self.assertRaises(ValueError):
            qf.dataset_arrays(COLUMNS, bad, SPEC)
        with self.assertRaises(ValueError):
            qf.dataset_arrays(COLUMNS[::-1], self.rows[:3], SPEC)


class MetricTest(unittest.TestCase):
    def test_pinball_loss(self):
        y = np.array([[0.02], [0.0]])
        f = np.full((2, 1, 3), 0.01)
        loss = qf.pinball(y, f, [0.1, 0.5, 0.9])
        np.testing.assert_allclose(loss[0, 0], [0.001, 0.005, 0.009])
        np.testing.assert_allclose(loss[1, 0], [0.009, 0.005, 0.001])

    def test_interval_figures_score_crossed_forecasts_as_produced(self):
        y = np.array([0.0, 0.5, 2.0, 0.5])
        f = np.array([[0.1, 0.5, 1.0], [0.1, 0.5, 1.0], [0.1, 0.5, 1.0], [1.0, 0.5, 0.0]])
        losses = qf.pinball(y[:, None], f[:, None, :], [0.1, 0.5, 0.9])[:, 0, :]
        s = qf.interval_summary(y, f, losses, 0.1)
        # The crossed row [1.0, 0.0] is both below its q10 and above its q90, and never covered.
        self.assertEqual((s["coverage"], s["belowQ10"], s["aboveQ90"]), (0.25, 0.5, 0.5))
        self.assertAlmostEqual(s["meanWidth"], (0.9 * 3 - 1.0) / 4)
        self.assertAlmostEqual(s["medianWidth"], 0.9)
        self.assertAlmostEqual(
            s["intervalScore"], float(np.mean(losses[:, 0] + losses[:, 2])) / 0.1
        )

    def test_comparison_counts_and_arithmetic(self):
        rng = np.random.default_rng(3)
        n = 50
        y = np.abs(rng.normal(size=(n, 3))) * 0.01
        model = np.sort(rng.normal(size=(n, 3, 3)) * 0.01, axis=2)
        model[0, 1] = [0.02, 0.01, 0.0]
        reference = np.repeat(np.array([[[0.001, 0.005, 0.02]] * 3]), n, axis=0)
        v = np.full(n, 0.01)
        days = np.arange(n) // 6
        result = qf.compare(y, model, reference, v, days, SPEC)
        self.assertEqual((result["observations"], result["days"]), (50, 9))
        lm, lb = qf.pinball(y, model, [0.1, 0.5, 0.9]), qf.pinball(y, reference, [0.1, 0.5, 0.9])
        self.assertAlmostEqual(
            result["primary"]["difference"],
            float(np.mean(lm.mean(axis=(1, 2)) - lb.mean(axis=(1, 2)))),
        )
        up = result["targets"]["upExcursion"]
        self.assertEqual(
            up["model"]["crossings"], {"q10AboveQ50": 1, "q50AboveQ90": 1, "q10AboveQ90": 1}
        )
        self.assertEqual(up["model"]["negativeForecasts"]["0.1"], int((model[:, 1, 0] < 0).sum()))
        self.assertIsNone(result["targets"]["terminalReturn"]["model"]["negativeForecasts"])
        self.assertAlmostEqual(
            up["model"]["medianAbsoluteError"], float(np.median(np.abs(y[:, 1] - model[:, 1, 1])))
        )
        self.assertAlmostEqual(
            up["model"]["pinballNormalized"]["0.9"], float(np.mean(lm[:, 1, 2] / 0.01))
        )
        self.assertEqual(
            qf.compare(y[:0], model[:0], reference[:0], v[:0], days[:0], SPEC),
            {"observations": 0, "days": 0},
        )


class UncertaintyTest(unittest.TestCase):
    def test_block_orders_are_seeded_unwrapped_blocks(self):
        orders = qf.block_orders(20, 7, 50)
        self.assertEqual(orders.shape, (50, 20))
        self.assertTrue(((orders >= 0) & (orders < 20)).all())
        for row in orders:
            for start in range(0, 20, 7):
                block = row[start : start + 7]
                np.testing.assert_array_equal(block, block[0] + np.arange(len(block)))
        np.testing.assert_array_equal(orders, qf.block_orders(20, 7, 50))
        np.testing.assert_array_equal(qf.block_orders(7, 7, 3), np.tile(np.arange(7), (3, 1)))

    def test_ratio_interval_and_undefined_replicates(self):
        spec = {"uncertainty": {"minimumDefinedReplicates": 9900, "levels": [0.025, 0.975]}}
        orders = qf.block_orders(30, 7, 10_000)
        constant = qf.ratio_interval(np.full(30, 0.5), np.full(30, 2), orders, spec)
        self.assertEqual(
            (constant["low"], constant["high"], constant["defined"]), (0.25, 0.25, 10_000)
        )
        sparse = np.zeros(30)
        sparse[0] = 1
        result = qf.ratio_interval(sparse, sparse, orders, spec)
        self.assertLess(result["defined"], 9900)
        self.assertIsNone(result["low"])

    def test_period_positions_cover_every_day(self):
        days = np.array([qf.iso_ms("2025-11-22T00:00:00.000Z") // qf.DAY_MS] * 3)
        result = qf.uncertainty_of(SPEC["periods"]["list"][1], days, {"primary": np.ones(3)}, SPEC)
        self.assertEqual(result["positions"], 181)
        final = qf.uncertainty_of(
            SPEC["periods"]["list"][2], days * 0 + B2 // qf.DAY_MS, {"x": np.ones(3)}, SPEC
        )
        self.assertEqual(final["positions"], 184)


class InterpretationTest(unittest.TestCase):
    def period(self, low, high, difference=-1.0, observations=5000, days=180):
        interval = {"low": low, "high": high}
        return {
            "observations": observations,
            "days": days,
            "difference": difference,
            "label": qf.period_label(interval),
        }

    def test_verdict_rules_in_order(self):
        better, unclear, worse = self.period(-2, -1), self.period(-1, 1), self.period(1, 2, 1.5)
        self.assertEqual(qf.verdict([better, better], SPEC), "IMPROVEMENT_IN_BOTH_PERIODS")
        self.assertEqual(qf.verdict([better, worse], SPEC), "NO_IMPROVEMENT")
        self.assertEqual(
            qf.verdict([self.period(-1, 1, 0.1), self.period(-1, 1, 0.0)], SPEC), "NO_IMPROVEMENT"
        )
        self.assertEqual(qf.verdict([better, unclear], SPEC), "INCONCLUSIVE")
        self.assertEqual(
            qf.verdict([better, self.period(-2, -1, days=89)], SPEC), "INSUFFICIENT_EVIDENCE"
        )
        self.assertEqual(
            qf.verdict([better, self.period(None, None)], SPEC), "INSUFFICIENT_EVIDENCE"
        )

    def test_consistency_calibration_and_informativeness(self):
        self.assertEqual(qf.consistency([{"low": -2, "high": -1}] * 2), "CONSISTENT_IMPROVEMENT")
        self.assertEqual(qf.consistency([{"low": 1, "high": 2}] * 2), "CONSISTENT_DETERIORATION")
        self.assertEqual(
            qf.consistency([{"low": -2, "high": -1}, {"low": -1, "high": 1}]), "NOT_CONSISTENT"
        )
        self.assertEqual(qf.consistency([{"low": None, "high": None}] * 2), "NOT_CONSISTENT")
        good = {
            "coverage": 0.8,
            "belowQ10": 0.1,
            "aboveQ90": 0.1,
            "meanWidth": 1.0,
            "intervalScore": 1.0,
        }
        self.assertEqual(qf.calibration(good), "CALIBRATED")
        self.assertEqual(qf.calibration({**good, "aboveQ90": 0.14}), "NOT_CALIBRATED")
        self.assertEqual(qf.calibration({**good, "coverage": 0.74}), "NOT_CALIBRATED")
        wide = {**good, "meanWidth": 2.0, "intervalScore": 2.0}
        self.assertEqual(qf.informative(good, wide), "INFORMATIVE_RELATIVE_TO_BASELINE")
        self.assertEqual(qf.informative(wide, good), "NOT_SHOWN")


class SyntheticStudyTest(unittest.TestCase):
    """Integration checks on synthetic data; success here is not evidence of financial skill."""

    def test_a_learnable_relationship_beats_the_baseline_in_both_periods(self):
        results = qf.run_study(COLUMNS, synthetic_rows(), SPEC)
        conclusion = results["conclusion"]
        self.assertEqual(conclusion["verdict"], "IMPROVEMENT_IN_BOTH_PERIODS")
        for name in SPEC["model"]["targets"]:
            self.assertEqual(conclusion["targets"][name]["consistency"], "CONSISTENT_IMPROVEMENT")
        self.assertEqual(
            results["observations"]["byPeriod"], {"train": 8740, "validation": 4324, "final": 4396}
        )
        self.assertEqual(results["observations"]["purged"], 40)
        development = results["evaluations"]["development"]
        self.assertEqual(development["fit"]["observations"], 8740)
        self.assertEqual(results["evaluations"]["final"]["fit"]["observations"], 8740 + 4324)
        self.assertEqual(len(development["fit"]["estimators"]), 9)
        self.assertTrue(all(e["nIter"] == 100 for e in development["fit"]["estimators"]))
        self.assertEqual(set(development["pairs"]), {"P0USDT", "P1USDT", "P2USDT", "P3USDT"})
        self.assertEqual(development["uncertainty"]["primary"]["defined"], 10_000)
        json.dumps(results, allow_nan=False)

    def test_unrelated_features_do_not_beat_the_baseline(self):
        conclusion = qf.run_study(COLUMNS, synthetic_rows(learnable=False), SPEC)["conclusion"]
        self.assertNotEqual(conclusion["verdict"], "IMPROVEMENT_IN_BOTH_PERIODS")


class RunnerTest(unittest.TestCase):
    def test_identity_refuses_a_dirty_tree(self):
        with self.assertRaises(RuntimeError):
            qf.code_identity(lambda *args: " M scripts/x.py" if args[0] == "status" else "abc")
        clean = qf.code_identity(lambda *args: "" if args[0] == "status" else "abc")
        self.assertEqual(clean["codeBlobs"], dict.fromkeys(qf.CODE_FILES, "abc"))

    def test_environment_refuses_a_version_that_differs_from_its_pin(self):
        requirements = "numpy==2.5.5 \\\n    --hash=sha256:x\nscikit-learn==1.9.1 \\\n"
        self.assertEqual(
            qf.pinned_versions(requirements), {"numpy": "2.5.5", "scikit-learn": "1.9.1"}
        )
        with self.assertRaises(RuntimeError):
            qf.check_environment(requirements, lambda name: "0.0")
        environment = qf.check_environment(
            requirements, {"numpy": "2.5.5", "scikit-learn": "1.9.1"}.get
        )
        self.assertEqual(environment["packages"]["scikit-learn"], "1.9.1")
        self.assertTrue(all("filepath" not in pool for pool in environment["threadpools"]))

    def test_dataset_must_be_this_commit_and_specification(self):
        manifest = {"codeCommit": "c", "specification": {"id": "s", "fileSha256": "f"}}
        qf.verify_dataset(manifest, "c", "f", "s")
        for args in (("d", "f", "s"), ("c", "g", "s"), ("c", "f", "t")):
            with self.assertRaises(ValueError):
                qf.verify_dataset(manifest, *args)

    def test_main_writes_once_and_never_overwrites(self):
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root)
        for name in (qf.SPEC_FILE, qf.REQUIREMENTS_FILE):
            (root / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(qf.ROOT / name, root / name)
        commit = "c" * 40
        out = root / qf.OUTPUT_DIR
        with self.assertRaises(FileNotFoundError):
            qf.dataset_path(out, commit)
        spec_sha = qf.sha256((root / qf.SPEC_FILE).read_bytes())
        manifest = {
            "codeCommit": commit,
            "specification": {
                "id": SPEC["specificationId"],
                "sha256": "a" * 64,
                "fileSha256": spec_sha,
            },
        }
        dataset = {
            "manifest": manifest,
            "coverage": {},
            "columns": COLUMNS,
            "rows": synthetic_rows(pairs=2),
        }
        out.mkdir()
        (out / f"{qf.DATASET_PREFIX}{'a' * 12}-{commit[:12]}.json").write_text(json.dumps(dataset))
        git = lambda *args: "" if args[0] == "status" else commit  # noqa: E731
        pins = qf.pinned_versions((root / qf.REQUIREMENTS_FILE).read_text(encoding="utf-8"))

        def run():
            with contextlib.redirect_stdout(io.StringIO()) as printed:
                code = qf.main(root, git, pins.get)
            return code, json.loads(printed.getvalue())

        code, report = run()
        self.assertEqual((code, report["status"]), (0, "CREATED"))
        written = (root / report["path"]).read_bytes()
        self.assertEqual(qf.sha256(written), report["contentSha256"])
        result = json.loads(written)
        self.assertEqual(result["manifest"]["dataset"]["manifest"], manifest)
        self.assertEqual(
            result["manifest"]["requirements"]["sha256"],
            qf.sha256((root / qf.REQUIREMENTS_FILE).read_bytes()),
        )
        self.assertEqual(run()[1]["status"], "UNCHANGED")
        (root / report["path"]).write_text("other")
        code, report = run()
        self.assertEqual((code, report["status"]), (1, "CONFLICT"))
        self.assertEqual((root / report["path"]).read_text(), "other")


if __name__ == "__main__":
    unittest.main()
