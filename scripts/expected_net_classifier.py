#!/usr/bin/env python3
"""Classifier step of stage D (docs/spot-24h-expected-net-t3s3-dev-v1.json).

Reads the joined observations that `npm run evaluate -- expected-net-export` wrote at the same
commit, fits the specification's HistGradientBoostingClassifier once per evaluation on its fit
splits only, and writes the class probabilities of the evaluated observations. No metric,
decision or figure: `npm run evaluate -- expected-net-evaluate` does that. Development research
on examined data: no network, account, order, alert or production store. Run from the repository
root, in the pinned venv:

    .venv/bin/python scripts/expected_net_classifier.py
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from importlib import metadata
from pathlib import Path

import numpy as np
import quantile_forecast as qf
from sklearn.ensemble import HistGradientBoostingClassifier

ROOT = qf.ROOT
SPEC_FILE = "docs/spot-24h-expected-net-t3s3-dev-v1.json"
REQUIREMENTS_FILE = qf.REQUIREMENTS_FILE
CODE_FILES = (
    SPEC_FILE,
    "scripts/expected_net_classifier.py",
    "scripts/quantile_forecast.py",
    REQUIREMENTS_FILE,
)
OUTPUT_DIR = qf.OUTPUT_DIR
PREFIX = "spot-24h-expected-net-t3s3-dev-v1"


def load_spec(root: Path = ROOT) -> dict:
    return json.loads((root / SPEC_FILE).read_text(encoding="utf-8"))


def dataset_arrays(columns: list, rows: list, spec: dict) -> tuple:
    """Features in features.candidate.order, the class and the split of every exported row."""
    features = spec["features"]["candidate"]["order"]
    classes = spec["outcome"]["classes"]["order"]
    at = {name: columns.index(name) for name in ("split", "class", *features)}
    x = np.array([[row[at[f]] for f in features] for row in rows], dtype=np.float64).reshape(
        len(rows), len(features)
    )
    if not np.isfinite(x).all():
        raise ValueError("Dataset holds a non-finite feature")
    y = np.array([row[at["class"]] for row in rows], dtype=object)
    if not set(y.tolist()) <= set(classes):
        raise ValueError("Dataset holds an unknown class")
    splits = np.array([row[at["split"]] for row in rows], dtype=object)
    return x, y, splits


def verified_params(spec: dict) -> dict:
    return {k: v for k, v in spec["forecasters"]["C"]["verifiedParams"].items() if k != "note"}


def fit_evaluation(x: np.ndarray, y: np.ndarray, splits: np.ndarray, evaluation: dict, spec: dict):
    """forecasters.C: fit on the evaluation's fit splits only, predict its evaluated split."""
    classes = spec["outcome"]["classes"]["order"]
    fit_mask = np.isin(splits, evaluation["fit"])
    evaluated = np.flatnonzero(splits == evaluation["evaluate"])
    counts = {k: int((y[fit_mask] == k).sum()) for k in classes}
    fit = {"splits": evaluation["fit"], "observations": int(fit_mask.sum()), "classes": counts}
    # forecasters.fitSetRequirement
    if min(counts.values()) == 0:
        return {"status": "MISSING_CLASS", "fit": fit, "rows": []}
    settings = spec["forecasters"]["C"]["settings"]
    # learning_rate and random_state come from forecasters.C.settings via **settings; the
    # fitted estimator's get_params() is checked against the specification below.
    model = HistGradientBoostingClassifier(**settings)  # NOSONAR
    model.fit(x[fit_mask], y[fit_mask].astype(str))
    params = model.get_params()
    if params != verified_params(spec):
        raise RuntimeError("Estimator parameters differ from the specification")
    order = [list(model.classes_).index(k) for k in classes]
    probabilities = model.predict_proba(x[evaluated])[:, order]
    if not np.isfinite(probabilities).all():
        raise ValueError("A probability is not finite")
    fit |= {
        "params": params,
        "classes_": [str(c) for c in model.classes_],
        "nIter": int(model.n_iter_),
    }
    rows = [[int(i), *map(float, p)] for i, p in zip(evaluated, probabilities, strict=True)]
    return {"status": "FITTED", "fit": fit, "rows": rows}


def run_fits(columns: list, rows: list, spec: dict) -> dict:
    """Both evaluations in one invocation, in specification order."""
    x, y, splits = dataset_arrays(columns, rows, spec)
    return {e["id"]: fit_evaluation(x, y, splits, e, spec) for e in spec["periods"]["evaluations"]}


# --------------------------------------------------------------------------------------------
# Identity and the write-once probabilities

Git = Callable[..., str]


def code_identity(git: Git = qf.run_git) -> dict:
    """As every runner: the commit names the code only if no tracked file differs from it."""
    changed = git("status", "--porcelain", "--untracked-files=no")
    if changed:
        raise RuntimeError(f"Tracked files differ from HEAD; commit before running:\n{changed}")
    return {
        "codeCommit": git("rev-parse", "HEAD"),
        "codeBlobs": {f: git("hash-object", f) for f in CODE_FILES},
    }


def dataset_path(directory: Path, commit: str) -> Path:
    matches = sorted(directory.glob(f"{PREFIX}-dataset-*-{commit[:12]}.json"))
    if len(matches) != 1:
        raise FileNotFoundError(
            f"Expected one dataset exported at {commit[:12]}, found {len(matches)}"
        )
    return matches[0]


def main(
    root: Path = ROOT, git: Git = qf.run_git, version: Callable[[str], str] = metadata.version
) -> int:
    spec_bytes = (root / SPEC_FILE).read_bytes()
    spec = json.loads(spec_bytes)
    identity = code_identity(git)
    requirements = (root / REQUIREMENTS_FILE).read_bytes()
    environment = qf.check_environment(requirements.decode("utf-8"), version)
    path = dataset_path(root / OUTPUT_DIR, identity["codeCommit"])
    dataset_bytes = path.read_bytes()
    dataset = json.loads(dataset_bytes)
    qf.verify_dataset(
        dataset["manifest"], identity["codeCommit"], qf.sha256(spec_bytes), spec["specificationId"]
    )
    evaluations = run_fits(dataset["columns"], dataset["rows"], spec)
    specification = dataset["manifest"]["specification"]
    manifest = {
        **identity,
        "specification": specification,
        "requirements": {"path": REQUIREMENTS_FILE, "sha256": qf.sha256(requirements)},
        "dataset": {"path": f"{OUTPUT_DIR}/{path.name}", "sha256": qf.sha256(dataset_bytes)},
    }
    content = json.dumps(
        {"manifest": manifest, "environment": environment, "evaluations": evaluations},
        allow_nan=False,
    )
    name = f"{PREFIX}-predictions-{specification['sha256'][:12]}-{identity['codeCommit'][:12]}.json"
    out = root / OUTPUT_DIR / name
    status = qf.write_once(out, f"{content}\n")
    report = {
        "status": status,
        "path": f"{OUTPUT_DIR}/{name}",
        "contentSha256": qf.sha256(f"{content}\n".encode()),
        "evaluations": {
            eid: {
                "status": e["status"],
                "observations": e["fit"]["observations"],
                "classes": e["fit"]["classes"],
                "nIter": e["fit"].get("nIter"),
                "evaluated": len(e["rows"]),
            }
            for eid, e in evaluations.items()
        },
    }
    print(json.dumps(report, indent=2))
    return 1 if status == "CONFLICT" else 0


if __name__ == "__main__":
    sys.exit(main())
