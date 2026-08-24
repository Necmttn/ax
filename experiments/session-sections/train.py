#!/usr/bin/env python3
"""Use eval.py for the first local SetFit experiment.

This package keeps train/predict/eval entrypoints so the classifier package
shape is stable while E3 is still experimental.
"""

from pathlib import Path
import runpy

runpy.run_path(str(Path(__file__).with_name("eval.py")), run_name="__main__")
