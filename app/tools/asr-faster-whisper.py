#!/usr/bin/env python3
"""Optional bilingual ASR backend for R2.

Contract expected by server.js when R2_ASR_CMD is set:
    R2_ASR_CMD="python" R2_ASR_ARGS='["<abs path>/asr-faster-whisper.py"]'
    -> server calls: <cmd> <args...> <wav-path>
The command must print the raw transcript to stdout (UTF-8) and exit 0.

This script is NOT installed by default. It requires the `faster-whisper`
package and a model that is already on disk (the local cache contains
Systran/faster-whisper-tiny). No network download is performed when
R2_WHISPER_MODEL points at a local model directory.

Example (PowerShell):
    $env:R2_ASR_CMD = "<abs path>/R2/asr-venv/Scripts/python.exe"
    $env:R2_ASR_ARGS = '["<abs path>/app/tools/asr-faster-whisper.py"]'
    $env:R2_WHISPER_MODEL = "<abs path to a local CTranslate2 model dir>"
    $env:R2_WHISPER_PROMPT = "KV cache，checkpoint，edge 节点，延迟，迁移"
"""
import os
import sys

sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: asr-faster-whisper.py <wav>", file=sys.stderr)
        return 2
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # pragma: no cover - optional dependency
        print(f"faster-whisper is not installed: {exc}", file=sys.stderr)
        return 3
    model_ref = os.environ.get("R2_WHISPER_MODEL", "tiny")
    device = os.environ.get("R2_WHISPER_DEVICE", "cpu")
    compute = os.environ.get("R2_WHISPER_COMPUTE", "int8")
    model = WhisperModel(model_ref, device=device, compute_type=compute, local_files_only=True)
    segments, info = model.transcribe(
        sys.argv[1], language=None, vad_filter=True, beam_size=5,
        initial_prompt=os.environ.get("R2_WHISPER_PROMPT") or None,
    )
    text = "".join(seg.text for seg in segments).strip()
    print(text)
    print(f"[detected language={info.language} prob={info.language_probability:.2f}]", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
