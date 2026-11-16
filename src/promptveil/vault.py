"""Local storage for the placeholder mapping and user word lists.

The vault holds real values in plain text on *your* machine only, so it is
created with 0600 permissions. ``promptveil forget`` deletes it.
"""

from __future__ import annotations

import json
import os
from pathlib import Path


def _xdg(var: str, default: str) -> Path:
    return Path(os.environ.get(var) or Path.home() / default)


def vault_path() -> Path:
    if os.environ.get("PROMPTVEIL_VAULT"):
        return Path(os.environ["PROMPTVEIL_VAULT"])
    return _xdg("XDG_DATA_HOME", ".local/share") / "promptveil" / "vault.json"


def config_dir() -> Path:
    if os.environ.get("PROMPTVEIL_CONFIG"):
        return Path(os.environ["PROMPTVEIL_CONFIG"])
    return _xdg("XDG_CONFIG_HOME", ".config") / "promptveil"


def load_mapping() -> dict[str, str]:
    p = vault_path()
    if not p.exists():
        return {}
    return json.loads(p.read_text(encoding="utf-8")).get("mapping", {})


def save_mapping(mapping: dict[str, str]) -> Path:
    p = vault_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump({"version": 1, "mapping": mapping}, fh, indent=2)
    os.replace(tmp, p)
    os.chmod(p, 0o600)
    return p


def forget() -> bool:
    p = vault_path()
    if p.exists():
        p.unlink()
        return True
    return False


def read_list(name: str) -> list[str]:
    """Read ``terms.txt`` / ``allow.txt`` from the config dir (one entry per line, # comments)."""
    p = config_dir() / name
    if not p.exists():
        return []
    return read_list_file(p)


def read_list_file(p: Path) -> list[str]:
    lines = Path(p).read_text(encoding="utf-8").splitlines()
    return [ln.strip() for ln in lines if ln.strip() and not ln.lstrip().startswith("#")]
