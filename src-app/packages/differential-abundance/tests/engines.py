#!/usr/bin/env python3
# ruff: noqa
"""The set of count-model engines that are ACTUALLY INSTALLED here, and the helper the acceptance
battery is parametrized over.

The battery must never be skippable. The compositional claim lives in the NORMALIZATION — the
size factors — and `_kernel` computes those ITSELF and hands the SAME ones to either engine
(`tests/test_kernel_normalization.py` pins PyDESeq2's internally-fitted factors equal to ours to
1e-10). `statsmodels` is pinned in the rootfs AND present wherever this suite runs, so the
`nb_glm` arm always executes and every acceptance assertion is made at least once for real. The
`pydeseq2` arm runs additionally wherever the wheel is installed (it is pinned in the rootfs, and
`differential-expression`'s own suite already treats its absence on a dev host as normal).
"""
from __future__ import annotations

import importlib.util


def installed_engines():
    """Engine keys whose real dependency imports here, default first. `nb_glm` is listed even if
    something is broken with `pydeseq2`, so the list is never empty and no arm can vanish."""
    out = []
    if importlib.util.find_spec("pydeseq2") is not None:
        out.append("pydeseq2")
    if importlib.util.find_spec("statsmodels") is not None:
        out.append("nb_glm")
    assert out, ("no differential-abundance count-model engine is installed; the acceptance "
                 "battery cannot be run, and it must not be silently skipped")
    return out


ENGINES = installed_engines()


def kernel_fail(message, code=2):
    """The `fail` callback the compute passes into `_kernel`; in-process it raises so a test can
    assert on the NAMED message instead of on an exit code."""
    raise KernelRefusal(message)


class KernelRefusal(Exception):
    pass
