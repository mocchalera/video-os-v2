from pathlib import Path


def write_output(output: Path, payload: str) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(payload)
