#!/usr/bin/env python3
"""24-hour quantile forecast study (docs/quantile-forecast-24h-dev-v1.json).

Reads the dataset that `npm run evaluate -- quantile-forecast-export` wrote at the same commit,
fits the specification's nine HistGradientBoostingRegressor quantile models and the
volatility-scaled empirical-quantile baseline for each evaluation, scores both on the ordinary
scale and writes one git-ignored result. Development research on examined data only: no network,
account, order, alert or production store. Run from the repository root, in the pinned venv:

    .venv/bin/python scripts/quantile_forecast.py
"""

from __future__ import annotations

import hashlib
import json
import math
import platform
import re
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from importlib import metadata
from pathlib import Path

import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from threadpoolctl import threadpool_info

ROOT = Path(__file__).resolve().parents[1]
SPEC_FILE = "docs/quantile-forecast-24h-dev-v1.json"
REQUIREMENTS_FILE = "scripts/quantile-forecast-requirements.txt"
CODE_FILES = (SPEC_FILE, "scripts/quantile_forecast.py", REQUIREMENTS_FILE)
OUTPUT_DIR = ".zerochart-reports"
DATASET_PREFIX = "quantile-forecast-24h-dev-v1-dataset-"
DAY_MS = 86_400_000
PURGED = -1
# uncertainty.draws and interpretation.calibration; a test checks them against the JSON text.
BOOTSTRAP_SEED = 20261125
COVERAGE_RANGE = (0.75, 0.85)
TAIL_RANGE = (0.07, 0.13)
THREADPOOL_KEYS = ("user_api", "internal_api", "prefix", "version", "num_threads")


def load_spec(root: Path = ROOT) -> dict:
    return json.loads((root / SPEC_FILE).read_text(encoding="utf-8"))


def iso_ms(text: str) -> int:
    return round(datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp() * 1000)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# --------------------------------------------------------------------------------------------
# Dataset and periods


@dataclass(frozen=True)
class Data:
    symbols: np.ndarray
    times: np.ndarray
    features: np.ndarray
    labels: np.ndarray
    v: np.ndarray


def dataset_arrays(columns: list, rows: list, spec: dict) -> Data:
    """The exported rows as arrays, checked against features.order and model.targets."""
    features, targets = spec["features"]["order"], spec["model"]["targets"]
    if list(columns) != ["symbol", "time", *features, *targets]:
        raise ValueError("Dataset columns differ from the specification")
    values = np.array([row[2:] for row in rows], dtype=np.float64).reshape(
        len(rows), len(columns) - 2
    )
    x, y = values[:, : len(features)], values[:, len(features) :]
    v = x[:, features.index("atr14OverClose")]
    if not np.isfinite(values).all() or not (v > 0).all():
        raise ValueError("Dataset holds a non-finite value or a non-positive v")
    return Data(
        symbols=np.array([row[0] for row in rows], dtype=object),
        times=np.array([row[1] for row in rows], dtype=np.int64),
        features=x,
        labels=y,
        v=v,
    )


def period_codes(times: np.ndarray, spec: dict) -> np.ndarray:
    """periods.membership: index into periods.list, or PURGED when the label crosses a boundary."""
    codes = np.full(times.shape, PURGED, dtype=np.int64)
    for code, period in enumerate(spec["periods"]["list"]):
        inside = (times >= iso_ms(period["start"])) & (times + DAY_MS <= iso_ms(period["end"]))
        codes[inside] = code
    return codes


def purged_by_boundary(times: np.ndarray, spec: dict) -> dict:
    """Observations whose label crosses each period's end."""
    result = {}
    for period in spec["periods"]["list"]:
        start, end = iso_ms(period["start"]), iso_ms(period["end"])
        result[period["end"]] = int(
            ((times >= start) & (times < end) & (times + DAY_MS > end)).sum()
        )
    return result


# --------------------------------------------------------------------------------------------
# Baseline and model, both on normalized targets


def fit_baseline(normalized: np.ndarray, quantiles: list) -> np.ndarray:
    """baseline.definition: type-7 empirical quantiles per target, shape (targets, quantiles)."""
    return np.array(
        [
            [np.quantile(normalized[:, t], q, method="linear") for q in quantiles]
            for t in range(normalized.shape[1])
        ]
    )


def fit_models(x: np.ndarray, normalized: np.ndarray, spec: dict) -> list:
    """model.fits: one estimator per target and quantile, target first, then quantile."""
    settings = spec["model"]["settings"]
    models = []
    for t in range(normalized.shape[1]):
        row = []
        for q in spec["model"]["quantiles"]:
            # learning_rate and random_state are set: they come from model.settings via **settings,
            # and a test checks every estimator's get_params() against the specification.
            estimator = HistGradientBoostingRegressor(quantile=q, **settings)  # NOSONAR
            row.append(estimator.fit(x, normalized[:, t]))
        models.append(row)
    return models


def model_forecasts(models: list, x: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Ordinary-scale forecasts, shape (observations, targets, quantiles): prediction times v."""
    normalized = np.stack([np.stack([m.predict(x) for m in row], axis=1) for row in models], axis=1)
    return normalized * v[:, None, None]


def baseline_forecasts(baseline: np.ndarray, v: np.ndarray) -> np.ndarray:
    return baseline[None, :, :] * v[:, None, None]


@dataclass(frozen=True)
class Fitted:
    baseline: np.ndarray
    models: list
    fit_mask: np.ndarray
    eval_mask: np.ndarray
    model: np.ndarray
    reference: np.ndarray


def fit_evaluation(data: Data, codes: np.ndarray, evaluation: dict, spec: dict) -> Fitted:
    """Fit on the evaluation's fitting periods only; forecast its evaluation period."""
    ids = [p["id"] for p in spec["periods"]["list"]]
    fit_mask = np.isin(codes, [ids.index(p) for p in evaluation["fit"]])
    eval_mask = codes == ids.index(evaluation["evaluate"])
    normalized = data.labels[fit_mask] / data.v[fit_mask][:, None]
    baseline = fit_baseline(normalized, spec["model"]["quantiles"])
    models = fit_models(data.features[fit_mask], normalized, spec)
    v = data.v[eval_mask]
    model = model_forecasts(models, data.features[eval_mask], v)
    reference = baseline_forecasts(baseline, v)
    # forecastTreatment: scored as produced; a non-finite forecast stops the run.
    if not (np.isfinite(model).all() and np.isfinite(reference).all()):
        raise ValueError("A forecast is not finite")
    return Fitted(baseline, models, fit_mask, eval_mask, model, reference)


# --------------------------------------------------------------------------------------------
# Metrics, ordinary scale unless named otherwise


def pinball(y: np.ndarray, f: np.ndarray, quantiles: list) -> np.ndarray:
    """rho_q(y - f) per observation, target and quantile; y (n, targets), f (n, targets, q)."""
    q = np.asarray(quantiles, dtype=np.float64)
    u = y[:, :, None] - f
    return np.maximum(q * u, (q - 1) * u)


def mean(values: np.ndarray) -> float:
    return float(np.mean(values))


def interval_summary(y: np.ndarray, f: np.ndarray, losses: np.ndarray, lower_q: float) -> dict:
    """metrics.interval for one target: f and losses (n, quantiles), the first and last quantile."""
    low, high = f[:, 0], f[:, -1]
    width = high - low
    return {
        "coverage": mean((low <= y) & (y <= high)),
        "belowQ10": mean(y < low),
        "aboveQ90": mean(y > high),
        "meanWidth": mean(width),
        "medianWidth": float(np.median(width)),
        "intervalScore": mean(losses[:, 0] + losses[:, -1]) / lower_q,
    }


def method_summary(
    y: np.ndarray, f: np.ndarray, losses: np.ndarray, v: np.ndarray, spec: dict, t: int
) -> dict:
    quantiles = spec["model"]["quantiles"]
    keys = [str(q) for q in quantiles]
    excursion = spec["model"]["targets"][t] != "terminalReturn"
    yt, ft, lt = y[:, t], f[:, t, :], losses[:, t, :]
    return {
        "pinball": {k: mean(lt[:, i]) for i, k in enumerate(keys)},
        "pinballNormalized": {k: mean(lt[:, i] / v) for i, k in enumerate(keys)},
        "shareBelow": {k: mean(yt < ft[:, i]) for i, k in enumerate(keys)},
        "interval": interval_summary(yt, ft, lt, quantiles[0]),
        "medianAbsoluteError": float(np.median(np.abs(yt - ft[:, len(quantiles) // 2]))),
        "crossings": {
            "q10AboveQ50": int((ft[:, 0] > ft[:, 1]).sum()),
            "q50AboveQ90": int((ft[:, 1] > ft[:, 2]).sum()),
            "q10AboveQ90": int((ft[:, 0] > ft[:, 2]).sum()),
        },
        "negativeForecasts": {k: int((ft[:, i] < 0).sum()) for i, k in enumerate(keys)}
        if excursion
        else None,
    }


def compare(
    y: np.ndarray,
    model: np.ndarray,
    reference: np.ndarray,
    v: np.ndarray,
    days: np.ndarray,
    spec: dict,
) -> dict:
    """Model against baseline on the same observations: primary metric and per-target figures."""
    if len(y) == 0:
        return {"observations": 0, "days": 0}
    quantiles = spec["model"]["quantiles"]
    lm, lb = pinball(y, model, quantiles), pinball(y, reference, quantiles)
    targets = {}
    for t, name in enumerate(spec["model"]["targets"]):
        m, b = (
            method_summary(y, model, lm, v, spec, t),
            method_summary(y, reference, lb, v, spec, t),
        )
        difference = {k: m["pinball"][k] - b["pinball"][k] for k in m["pinball"]}
        targets[name] = {
            "difference": mean(lm[:, t, :] - lb[:, t, :]),
            "pinballDifference": difference,
            "relativeDifference": {k: m["pinball"][k] / b["pinball"][k] - 1 for k in m["pinball"]},
            "model": m,
            "baseline": b,
        }
    model_mean, baseline_mean = mean(lm), mean(lb)
    return {
        "observations": len(y),
        "days": int(np.unique(days).size),
        "primary": {
            "model": model_mean,
            "baseline": baseline_mean,
            "difference": mean(lm - lb),
            "relativeDifference": model_mean / baseline_mean - 1,
        },
        "targets": targets,
    }


# --------------------------------------------------------------------------------------------
# Uncertainty: moving block bootstrap over UTC decision days, all pairs together


def block_orders(
    positions: int, block: int, replicates: int, seed: int = BOOTSTRAP_SEED
) -> np.ndarray:
    """uncertainty.draws: one integers call; row r holds replicate r's day positions."""
    rng = np.random.default_rng(seed)
    blocks = math.ceil(positions / block)
    starts = rng.integers(0, positions - block + 1, size=(replicates, blocks), dtype=np.int64)
    return (starts[:, :, None] + np.arange(block)).reshape(replicates, -1)[:, :positions]


def ratio_interval(
    day_sum: np.ndarray, day_count: np.ndarray, orders: np.ndarray, spec: dict
) -> dict:
    """Per replicate sum(d) / observations over the resampled days; type-7 percentiles."""
    u = spec["uncertainty"]
    numerator, denominator = day_sum[orders].sum(axis=1), day_count[orders].sum(axis=1)
    defined = denominator > 0
    result = {"replicates": len(orders), "defined": int(defined.sum()), "low": None, "high": None}
    if result["defined"] >= u["minimumDefinedReplicates"]:
        low, high = np.quantile(
            numerator[defined] / denominator[defined], u["levels"], method="linear"
        )
        result.update(low=float(low), high=float(high))
    return result


def uncertainty_of(period: dict, days: np.ndarray, quantities: dict, spec: dict) -> dict:
    u = spec["uncertainty"]
    first = iso_ms(period["start"]) // DAY_MS
    positions = (iso_ms(period["end"]) - DAY_MS) // DAY_MS - first + 1
    orders = block_orders(positions, u["blockDays"], u["replicates"])
    at = days - first
    count = np.bincount(at, minlength=positions)
    return {
        "positions": positions,
        **{
            name: ratio_interval(
                np.bincount(at, weights=d, minlength=positions), count, orders, spec
            )
            for name, d in quantities.items()
        },
    }


# --------------------------------------------------------------------------------------------
# Interpretation


def period_label(interval: dict) -> str | None:
    if interval["low"] is None:
        return None
    if interval["high"] < 0:
        return "BETTER"
    if interval["low"] > 0:
        return "WORSE"
    return "NO_CLEAR_DIFFERENCE"


def verdict(periods: list, spec: dict) -> str:
    """interpretation.verdict, in its order; periods hold observations, days, label, difference."""
    minimum = spec["interpretation"]["minimumEvidence"]
    if any(
        p["observations"] < minimum["observations"]
        or p["days"] < minimum["distinctDays"]
        or p["label"] is None
        for p in periods
    ):
        return "INSUFFICIENT_EVIDENCE"
    labels = [p["label"] for p in periods]
    if all(label == "BETTER" for label in labels):
        return "IMPROVEMENT_IN_BOTH_PERIODS"
    if "WORSE" in labels or all(p["difference"] >= 0 for p in periods):
        return "NO_IMPROVEMENT"
    return "INCONCLUSIVE"


def consistency(intervals: list) -> str:
    if any(i["low"] is None for i in intervals):
        return "NOT_CONSISTENT"
    if all(i["high"] < 0 for i in intervals):
        return "CONSISTENT_IMPROVEMENT"
    if all(i["low"] > 0 for i in intervals):
        return "CONSISTENT_DETERIORATION"
    return "NOT_CONSISTENT"


def within(x: float, bounds: tuple) -> bool:
    return bounds[0] <= x <= bounds[1]


def calibration(interval: dict) -> str:
    ok = within(interval["coverage"], COVERAGE_RANGE) and all(
        within(interval[k], TAIL_RANGE) for k in ("belowQ10", "aboveQ90")
    )
    return "CALIBRATED" if ok else "NOT_CALIBRATED"


def informative(model: dict, baseline: dict) -> str:
    if (
        calibration(model) == "CALIBRATED"
        and model["meanWidth"] < baseline["meanWidth"]
        and model["intervalScore"] < baseline["intervalScore"]
    ):
        return "INFORMATIVE_RELATIVE_TO_BASELINE"
    return "NOT_SHOWN"


def sign(x: float) -> int:
    return (x > 0) - (x < 0)


def conclude(evaluations: dict, spec: dict) -> dict:
    periods = {
        eid: {
            "observations": e["overall"]["observations"],
            "days": e["overall"]["days"],
            "difference": e["overall"]["primary"]["difference"],
            "interval": e["uncertainty"]["primary"],
            "label": period_label(e["uncertainty"]["primary"]),
        }
        for eid, e in evaluations.items()
    }
    targets, intervals = {}, {}
    for name in spec["model"]["targets"]:
        targets[name] = {
            "consistency": consistency([e["uncertainty"][name] for e in evaluations.values()]),
            "signs": {
                eid: {
                    k: sign(d)
                    for k, d in e["overall"]["targets"][name]["pinballDifference"].items()
                }
                for eid, e in evaluations.items()
            },
        }
        intervals[name] = {
            eid: {
                "model": calibration(e["overall"]["targets"][name]["model"]["interval"]),
                "baseline": calibration(e["overall"]["targets"][name]["baseline"]["interval"]),
                "informative": informative(
                    e["overall"]["targets"][name]["model"]["interval"],
                    e["overall"]["targets"][name]["baseline"]["interval"],
                ),
            }
            for eid, e in evaluations.items()
        }
    return {
        "verdict": verdict(list(periods.values()), spec),
        "periods": periods,
        "targets": targets,
        "intervals": intervals,
    }


# --------------------------------------------------------------------------------------------
# The study


def evaluate(data: Data, codes: np.ndarray, evaluation: dict, spec: dict) -> dict:
    fitted = fit_evaluation(data, codes, evaluation, spec)
    mask, quantiles = fitted.eval_mask, spec["model"]["quantiles"]
    y, v, days, symbols = (
        data.labels[mask],
        data.v[mask],
        data.times[mask] // DAY_MS,
        data.symbols[mask],
    )
    losses = pinball(y, fitted.model, quantiles) - pinball(y, fitted.reference, quantiles)
    quantities = {"primary": losses.mean(axis=(1, 2))}
    quantities.update(
        {name: losses[:, t, :].mean(axis=1) for t, name in enumerate(spec["model"]["targets"])}
    )
    period = next(p for p in spec["periods"]["list"] if p["id"] == evaluation["evaluate"])
    pairs = {}
    for symbol in dict.fromkeys(symbols.tolist()):
        at = symbols == symbol
        pairs[symbol] = compare(
            y[at], fitted.model[at], fitted.reference[at], v[at], days[at], spec
        )
    return {
        "fit": {
            "periods": evaluation["fit"],
            "observations": int(fitted.fit_mask.sum()),
            "days": int(np.unique(data.times[fitted.fit_mask] // DAY_MS).size),
            "baselineNormalizedQuantiles": {
                name: dict(zip(map(str, quantiles), map(float, fitted.baseline[t]), strict=True))
                for t, name in enumerate(spec["model"]["targets"])
            },
            "estimators": [
                {"target": name, "params": m.get_params(), "nIter": int(m.n_iter_)}
                for name, row in zip(spec["model"]["targets"], fitted.models, strict=True)
                for m in row
            ],
        },
        "overall": compare(y, fitted.model, fitted.reference, v, days, spec),
        "uncertainty": uncertainty_of(period, days, quantities, spec),
        "pairs": pairs,
    }


def run_study(columns: list, rows: list, spec: dict) -> dict:
    data = dataset_arrays(columns, rows, spec)
    codes = period_codes(data.times, spec)
    ids = [p["id"] for p in spec["periods"]["list"]]
    evaluations = {e["id"]: evaluate(data, codes, e, spec) for e in spec["evaluations"]}
    return {
        "specificationId": spec["specificationId"],
        "observations": {
            "exported": len(rows),
            "byPeriod": {pid: int((codes == i).sum()) for i, pid in enumerate(ids)},
            "purged": int((codes == PURGED).sum()),
            "purgedAtBoundary": purged_by_boundary(data.times, spec),
        },
        "evaluations": evaluations,
        "conclusion": conclude(evaluations, spec),
    }


# --------------------------------------------------------------------------------------------
# Identity, environment and the write-once result

Git = Callable[..., str]


def run_git(*args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=ROOT, check=True, capture_output=True, text=True
    ).stdout.strip()


def code_identity(git: Git = run_git) -> dict:
    """As the TypeScript runners: the commit names the code only if no tracked file differs."""
    changed = git("status", "--porcelain", "--untracked-files=no")
    if changed:
        raise RuntimeError(f"Tracked files differ from HEAD; commit before running:\n{changed}")
    return {
        "codeCommit": git("rev-parse", "HEAD"),
        "codeBlobs": {f: git("hash-object", f) for f in CODE_FILES},
    }


def pinned_versions(requirements: str) -> dict:
    return dict(re.findall(r"^([A-Za-z0-9_.-]+)==([^\s\\]+)", requirements, flags=re.MULTILINE))


def check_environment(requirements: str, version: Callable[[str], str] = metadata.version) -> dict:
    """environment.requirements: refuse any installed version that differs from its pin."""
    pins = pinned_versions(requirements)
    installed = {name: version(name) for name in pins}
    wrong = sorted(name for name in pins if installed[name] != pins[name])
    if wrong:
        raise RuntimeError(f"Installed versions differ from the pins: {', '.join(wrong)}")
    return {
        "python": sys.version,
        "implementation": platform.python_implementation(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "packages": installed,
        "threadpools": [{k: pool.get(k) for k in THREADPOOL_KEYS} for pool in threadpool_info()],
    }


def dataset_path(directory: Path, commit: str) -> Path:
    matches = sorted(directory.glob(f"{DATASET_PREFIX}*-{commit[:12]}.json"))
    if len(matches) != 1:
        raise FileNotFoundError(
            f"Expected one dataset exported at {commit[:12]}, found {len(matches)}"
        )
    return matches[0]


def verify_dataset(manifest: dict, commit: str, spec_file_sha256: str, spec_id: str) -> None:
    if manifest["codeCommit"] != commit:
        raise ValueError(f"The dataset was exported at {manifest['codeCommit']}, not {commit}")
    specification = manifest["specification"]
    if specification["id"] != spec_id or specification["fileSha256"] != spec_file_sha256:
        raise ValueError("The dataset names another specification")


def write_once(path: Path, content: str) -> str:
    """output.writeOnce: CREATED, UNCHANGED for identical bytes, or CONFLICT without writing."""
    path.parent.mkdir(parents=True, exist_ok=True)
    data = content.encode("utf-8")
    try:
        with path.open("xb") as handle:
            handle.write(data)
        return "CREATED"
    except FileExistsError:
        return "UNCHANGED" if path.read_bytes() == data else "CONFLICT"


def summary(results: dict) -> dict:
    c = results["conclusion"]
    return {
        "verdict": c["verdict"],
        "periods": {
            eid: {k: p[k] for k in ("observations", "days", "difference", "label")}
            | {"low": p["interval"]["low"], "high": p["interval"]["high"]}
            for eid, p in c["periods"].items()
        },
        "targets": {name: t["consistency"] for name, t in c["targets"].items()},
        "intervals": c["intervals"],
    }


def main(
    root: Path = ROOT, git: Git = run_git, version: Callable[[str], str] = metadata.version
) -> int:
    spec_bytes = (root / SPEC_FILE).read_bytes()
    spec = json.loads(spec_bytes)
    identity = code_identity(git)
    requirements = (root / REQUIREMENTS_FILE).read_bytes()
    environment = check_environment(requirements.decode("utf-8"), version)
    path = dataset_path(root / OUTPUT_DIR, identity["codeCommit"])
    dataset_bytes = path.read_bytes()
    dataset = json.loads(dataset_bytes)
    verify_dataset(
        dataset["manifest"], identity["codeCommit"], sha256(spec_bytes), spec["specificationId"]
    )
    results = run_study(dataset["columns"], dataset["rows"], spec)
    specification = dataset["manifest"]["specification"]
    manifest = {
        **identity,
        "specification": specification,
        "requirements": {"path": REQUIREMENTS_FILE, "sha256": sha256(requirements)},
        "dataset": {
            "path": f"{OUTPUT_DIR}/{path.name}",
            "sha256": sha256(dataset_bytes),
            "manifest": dataset["manifest"],
        },
    }
    content = json.dumps(
        {
            "manifest": manifest,
            "environment": environment,
            "coverage": dataset["coverage"],
            "results": results,
        },
        indent=2,
        allow_nan=False,
    )
    out = root / OUTPUT_DIR / f"quantile-forecast-24h-dev-v1-{specification['sha256'][:12]}.json"
    status = write_once(out, f"{content}\n")
    report = {
        "status": status,
        "path": f"{OUTPUT_DIR}/{out.name}",
        "contentSha256": sha256(f"{content}\n".encode()),
        "summary": summary(results),
    }
    print(json.dumps(report, indent=2))
    return 1 if status == "CONFLICT" else 0


if __name__ == "__main__":
    sys.exit(main())
