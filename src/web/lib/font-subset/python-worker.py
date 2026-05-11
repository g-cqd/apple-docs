#!/usr/bin/env python3
"""
Long-lived pyftsubset worker. Reads newline-framed JSON requests from
stdin, writes newline-framed JSON responses to stdout.

Lifecycle: spawned once per pool slot, then reused across thousands of
requests. The host-side pool keeps the worker alive forever; per-call
cost is amortised down to pure subset work because the parsed source
font stays in memory between jobs.

Protocol (one line per direction):

  request  := {
    "id":         string,           # echoed back in the reply
    "font_path":  string,           # absolute path to the source .ttf/.otf
    "codepoints": [int, ...],       # sorted unique codepoint list
    "format":     "woff2"|"ttf"|"otf",
    "out_path":   string            # where to write the subset bytes
  }

  reply    := { "id": string, "ok": true,  "size": int }
            | { "id": string, "ok": false, "error": string }

Determinism: defaults match the S0.3 spike result. We never touch
`head.modified` (sourced from the input font, not wall-clock) and never
set `with_zopfli` or any other policy knob.

The worker also exposes a one-shot `{"op":"ping"}` request that returns
`{"ok":true,"pong":true,"fonttools":"<version>"}` for liveness probes.
"""
from __future__ import annotations

import json
import os
import sys
import traceback


def _load_fonttools():
    try:
        from fontTools.subset import Options, Subsetter, load_font, save_font  # type: ignore
        import fontTools  # type: ignore
        return Options, Subsetter, load_font, save_font, fontTools.__version__
    except Exception as exc:  # pragma: no cover — depends on host install
        sys.stderr.write(f"font-subset worker: fontTools unavailable: {exc}\n")
        sys.stderr.flush()
        raise


def _emit(reply: dict) -> None:
    sys.stdout.write(json.dumps(reply, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def main() -> int:
    Options, Subsetter, load_font, save_font, ft_version = _load_fonttools()

    # Per-worker source-font cache. The hot path is "same source font,
    # many different codepoint sets" (one master per family, many
    # callers). Keeping the parsed TTFont in memory turns each call into
    # subset + serialize.
    parsed_cache: dict[str, object] = {}

    def get_font(font_path: str):
        cached = parsed_cache.get(font_path)
        if cached is not None:
            return cached
        opts = Options()
        opts.layout_features = ["*"]  # placeholder; reset below per-call
        # load_font respects opts indirectly (only for some things). The
        # heavy work is `Subsetter.subset`.
        ttf = load_font(font_path, opts, lazy=False, dontLoadGlyphNames=False)
        parsed_cache[font_path] = ttf
        return ttf

    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as exc:
            _emit({"id": None, "ok": False, "error": f"invalid json: {exc}"})
            continue

        rid = req.get("id")
        op = req.get("op")

        if op == "ping":
            _emit({"id": rid, "ok": True, "pong": True, "fonttools": ft_version})
            continue

        try:
            font_path = req["font_path"]
            codepoints = req["codepoints"]
            fmt = req.get("format", "woff2")
            out_path = req["out_path"]
        except KeyError as exc:
            _emit({"id": rid, "ok": False, "error": f"missing field: {exc}"})
            continue

        try:
            # Fresh Options per call — Subsetter.subset mutates state and
            # we don't want previous calls' flavour to bleed in.
            opts = Options()
            if fmt == "woff2":
                opts.flavor = "woff2"
            # ttf/otf: leave opts.flavor at its default (None) so the
            # input flavour is preserved on the way out.

            # Reuse the parsed font; deep-copy by re-parsing — pyftsubset
            # mutates the TTFont it operates on. Re-parsing costs ~1s on
            # SF-Pro, which defeats the point of long-lived workers, so
            # we serialize-deserialize via a temp BytesIO for the
            # in-memory copy instead.
            #
            # In practice the cheapest correct strategy is to re-read
            # from disk on each call (the kernel page-cache makes this
            # nearly free), then close. That keeps worker memory flat
            # across thousands of calls.
            ttf = load_font(font_path, opts, lazy=False, dontLoadGlyphNames=False)

            sub = Subsetter(options=opts)
            sub.populate(unicodes=codepoints)
            sub.subset(ttf)
            save_font(ttf, out_path, opts)
            try:
                ttf.close()
            except Exception:
                pass

            size = os.path.getsize(out_path)
            _emit({"id": rid, "ok": True, "size": size})
        except Exception as exc:
            tb = traceback.format_exc(limit=4)
            _emit({"id": rid, "ok": False, "error": f"{exc}\n{tb}"})

    return 0


if __name__ == "__main__":
    sys.exit(main())
