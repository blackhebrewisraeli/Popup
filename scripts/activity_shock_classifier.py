#!/usr/bin/env python3
"""Fit step of the activityShock24h screen (docs/spot-24h-activity-shock-increment-dev-v1.json).

Reads the joined dataset that `npm run evaluate -- activity-export` wrote at the same commit and
fits #222's classifier C four times with #222's own fit function, settings and verifiedParams:
development A, development B, final A, final B. Arm A uses #220's eleven features, arm B the same
eleven plus activityShock24h, on the same common observations. Checks that arm A reproduces #222's
recorded C probabilities when the observation sets equal #222's, then writes the probabilities
once. No metric, interval or verdict: `npm run evaluate -- activity-evaluate` does that.
Development research on examined data: no network, account, order or production store.

    .venv/bin/python scripts/activity_shock_classifier.py
"""

from __future__ import annotations

import json
import sys
from collections.abc import Callable
from importlib import metadata
from pathlib import Path

import expected_net_classifier as enc
import numpy as np
import quantile_forecast as qf

ROOT = qf.ROOT
SPEC_FILE = "docs/spot-24h-activity-shock-increment-dev-v1.json"
REQUIREMENTS_FILE = qf.REQUIREMENTS_FILE
CODE_FILES = (
    SPEC_FILE,
    "scripts/activity_shock_classifier.py",
    "scripts/expected_net_classifier.py",
    "scripts/quantile_forecast.py",
    enc.SPEC_FILE,
    REQUIREMENTS_FILE,
)
OUTPUT_DIR = qf.OUTPUT_DIR
PREFIX = "spot-24h-activity-shock-increment-dev-v1"
ACTIVITY = "activityShock24h"
ARMS = ("A", "B")
# estimator.reproductionOfC
TOLERANCE = 1e-12


class IntegrityFailure(RuntimeError):
    """verdict.order INTEGRITY_FAILURE: the step stops, writes nothing and names the cause."""


def load_stage_d(root: Path, spec: dict) -> dict:
    """#222's specification, hash-verified: the source of C's settings and verifiedParams."""
    data = (root / enc.SPEC_FILE).read_bytes()
    if qf.sha256(data) != spec["basis"]["estimatorSource"]["fileSha256"]:
        raise IntegrityFailure("#222's specification differs from its recorded SHA-256")
    stage_d = json.loads(data)
    if stage_d["forecasters"]["C"]["settings"] != spec["estimator"]["settings"]:
        raise IntegrityFailure("estimator.settings differ from #222's C")
    return stage_d


def arm_features(stage_d: dict) -> dict:
    """arms: A is #220's eleven in #222's order; B appends activityShock24h as the twelfth."""
    eleven = list(stage_d["features"]["candidate"]["order"])
    return {"A": eleven, "B": [*eleven, ACTIVITY]}


def common_arrays(columns: list, rows: list, features: list, classes: list) -> tuple:
    """observations.common: rows with no exclusion only, in dataset order, for either arm."""
    at = {name: columns.index(name) for name in ("exclusion", "split", "class", *features)}
    common = [i for i, row in enumerate(rows) if row[at["exclusion"]] is None]
    x = np.array(
        [[rows[i][at[f]] for f in features] for i in common], dtype=np.float64
    ).reshape(len(common), len(features))
    if not np.isfinite(x).all():
        raise ValueError("A common observation holds a non-finite feature")
    y = np.array([rows[i][at["class"]] for i in common], dtype=object)
    if not set(y.tolist()) <= set(classes):
        raise ValueError("Dataset holds an unknown class")
    splits = np.array([rows[i][at["split"]] for i in common], dtype=object)
    return np.array(common, dtype=np.int64), x, y, splits


def fit_arms(columns: list, rows: list, spec: dict, stage_d: dict) -> dict:
    """estimator.fits: development A, development B, final A, final B, with #222's fit function."""
    classes = stage_d["outcome"]["classes"]["order"]
    arms = {arm: common_arrays(columns, rows, f, classes) for arm, f in arm_features(stage_d).items()}
    if not (np.array_equal(arms["A"][0], arms["B"][0]) and np.array_equal(arms["A"][2], arms["B"][2])):
        raise IntegrityFailure("the arms' observations or labels differ")
    fits: dict = {}
    for evaluation in spec["evaluations"]:
        fits[evaluation["id"]] = {}
        for arm in ARMS:
            index, x, y, splits = arms[arm]
            fitted = enc.fit_evaluation(x, y, splits, evaluation, stage_d)
            fitted["fit"]["features"] = arm_features(stage_d)[arm]
            fitted["rows"] = [[int(index[r[0]]), *r[1:]] for r in fitted["rows"]]
            fits[evaluation["id"]][arm] = fitted
    return fits


def reproduction_of_c(columns: list, rows: list, spec: dict, fits: dict, recorded: dict) -> dict:
    """estimator.reproductionOfC: arm A equals #222's C wherever the observation sets are #222's."""
    at = {name: columns.index(name) for name in ("stageDRow", "exclusion", "split")}
    report = {}
    for evaluation in spec["evaluations"]:
        eid = evaluation["id"]

        def stage_d_rows(splits: list) -> list:
            return [r for r in rows if r[at["stageDRow"]] is not None and r[at["split"]] in splits]

        fit_set = stage_d_rows(evaluation["fit"])
        evaluated = stage_d_rows([evaluation["evaluate"]])
        excluded = {
            "fit": sum(r[at["exclusion"]] is not None for r in fit_set),
            "evaluated": sum(r[at["exclusion"]] is not None for r in evaluated),
        }
        counts = {"fit": len(fit_set), "evaluated": len(evaluated), "excluded": excluded}
        if excluded["fit"] or excluded["evaluated"]:
            report[eid] = {"status": "NOT_APPLICABLE", **counts}
            continue
        mine, theirs = fits[eid]["A"], recorded["evaluations"][eid]
        if mine["status"] != theirs["status"] or mine["fit"]["observations"] != theirs["fit"]["observations"]:
            raise IntegrityFailure(f"{eid}: arm A's fit differs from #222's C")
        mapped = [rows[r[0]][at["stageDRow"]] for r in mine["rows"]]
        if mapped != [r[0] for r in theirs["rows"]]:
            raise IntegrityFailure(f"{eid}: arm A's evaluated rows differ from #222's")
        a = np.array([r[1:] for r in mine["rows"]], dtype=np.float64)
        c = np.array([r[1:] for r in theirs["rows"]], dtype=np.float64)
        worst = float(np.max(np.abs(a - c))) if a.size else 0.0
        if not worst <= TOLERANCE:
            raise IntegrityFailure(f"{eid}: arm A differs from #222's C by {worst}")
        report[eid] = {"status": "PASS", "maxAbsoluteDifference": worst, "tolerance": TOLERANCE, **counts}
    return report


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
        raise FileNotFoundError(f"Expected one dataset exported at {commit[:12]}, found {len(matches)}")
    return matches[0]


def recorded_predictions(root: Path, spec: dict) -> dict:
    source = spec["basis"]["estimatorSource"]["predictions"]
    data = (root / source["path"]).read_bytes()
    if qf.sha256(data) != source["sha256"]:
        raise IntegrityFailure("#222's predictions differ from their recorded SHA-256")
    return json.loads(data)


def main(root: Path = ROOT, git: Git = qf.run_git, version: Callable[[str], str] = metadata.version) -> int:
    spec_bytes = (root / SPEC_FILE).read_bytes()
    spec = json.loads(spec_bytes)
    identity = code_identity(git)
    requirements = (root / REQUIREMENTS_FILE).read_bytes()
    environment = qf.check_environment(requirements.decode("utf-8"), version)
    stage_d = load_stage_d(root, spec)
    recorded = recorded_predictions(root, spec)
    path = dataset_path(root / OUTPUT_DIR, identity["codeCommit"])
    dataset_bytes = path.read_bytes()
    dataset = json.loads(dataset_bytes)
    qf.verify_dataset(dataset["manifest"], identity["codeCommit"], qf.sha256(spec_bytes), spec["specificationId"])
    fits = fit_arms(dataset["columns"], dataset["rows"], spec, stage_d)
    reproduction = reproduction_of_c(dataset["columns"], dataset["rows"], spec, fits, recorded)
    specification = dataset["manifest"]["specification"]
    manifest = {
        **identity,
        "specification": specification,
        "requirements": {"path": REQUIREMENTS_FILE, "sha256": qf.sha256(requirements)},
        "dataset": {"path": f"{OUTPUT_DIR}/{path.name}", "sha256": qf.sha256(dataset_bytes)},
        "stageD": {
            "specification": {"path": enc.SPEC_FILE, "fileSha256": spec["basis"]["estimatorSource"]["fileSha256"]},
            "predictions": spec["basis"]["estimatorSource"]["predictions"],
        },
    }
    environment = {**environment, "stageDThreadpools": recorded["environment"]["threadpools"]}
    content = json.dumps(
        {"manifest": manifest, "environment": environment, "evaluations": fits, "reproductionOfC": reproduction},
        allow_nan=False,
    )
    name = f"{PREFIX}-predictions-{specification['sha256'][:12]}-{identity['codeCommit'][:12]}.json"
    status = qf.write_once(root / OUTPUT_DIR / name, f"{content}\n")
    report = {
        "status": status,
        "path": f"{OUTPUT_DIR}/{name}",
        "contentSha256": qf.sha256(f"{content}\n".encode()),
        "reproductionOfC": reproduction,
        "fits": {
            eid: {
                arm: {
                    "status": f["status"],
                    "observations": f["fit"]["observations"],
                    "classes": f["fit"]["classes"],
                    "nIter": f["fit"].get("nIter"),
                    "evaluated": len(f["rows"]),
                }
                for arm, f in arms.items()
            }
            for eid, arms in fits.items()
        },
    }
    print(json.dumps(report, indent=2))
    return 1 if status == "CONFLICT" else 0


if __name__ == "__main__":
    sys.exit(main())
