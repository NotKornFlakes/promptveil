"""Local storage for the placeholder mapping (the "vault") and the user's word lists.

The vault maps placeholders to real values and lives in ``vault.json`` (created 0600).

* With the ``secure`` extra (``pip install 'promptveil[secure]'``) the vault is encrypted with
  AES-256-GCM. The key is a random 32-byte key kept in your OS keyring through ``secret-tool``
  (libsecret), or is derived from a password (``--password`` / ``PROMPTVEIL_PASSWORD``) with
  scrypt. If neither is available, saving fails: the vault is never quietly written in plain text.
* Without the extra, the vault is plain text, and a one-time note says so.
* It expires: every scrub sets an expiry (``--ttl``, or ``ttl`` in ``config.ini``, default 24h),
  and an expired vault is deleted on the next run.

``promptveil forget`` deletes it.
"""

from __future__ import annotations

import base64
import configparser
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

FORMAT = 2
DEFAULT_TTL = 24 * 3600  # seconds; used when neither --ttl nor config.ini sets one
SCRYPT_N, SCRYPT_R, SCRYPT_P = 2**17, 8, 1  # 128 MiB, about 0.3 s
KEYRING_ATTRS = ["service", "promptveil", "key", "vault"]


class VaultError(Exception):
    """A problem to show the user as ``promptveil: <message>`` (exit code 2), without a traceback."""


def have_crypto() -> bool:
    try:
        import cryptography.hazmat.primitives.ciphers.aead  # noqa: F401
    except ImportError:
        return False
    return True


# ---------------------------------------------------------------------------- paths and config


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


_TTL = re.compile(r"^\s*(\d+)\s*([smhd])\s*$", re.IGNORECASE)
_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}


def parse_ttl(text: str) -> int | None:
    """``"90m"`` -> 5400 seconds; ``"never"`` -> None (no expiry). Raises ValueError otherwise."""
    if text.strip().lower() in ("never", "none", "off"):
        return None
    m = _TTL.match(text)
    if not m or int(m.group(1)) == 0:
        raise ValueError(f"invalid ttl {text!r}: use e.g. 30m, 2h, 1d or never")
    return int(m.group(1)) * _UNITS[m.group(2).lower()]


def default_ttl() -> int | None:
    """``ttl`` from ``[vault]`` in ``config.ini``, else 24 hours."""
    p = config_dir() / "config.ini"
    if p.exists():
        cfg = configparser.ConfigParser()
        try:
            cfg.read(p, encoding="utf-8")
        except configparser.Error as e:
            raise VaultError(f"can't read {p}: {e.__class__.__name__}") from None
        if cfg.has_option("vault", "ttl"):
            try:
                return parse_ttl(cfg.get("vault", "ttl"))
            except ValueError as e:
                raise VaultError(f"{p}: {e}") from None
    return DEFAULT_TTL


# ---------------------------------------------------------------------------- reading the file


def _read() -> dict | None:
    p = vault_path()
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError
    except (ValueError, UnicodeDecodeError):
        raise VaultError(f"the vault file is damaged: {p}. Run `promptveil forget` to start over.") from None
    return data


def purge_expired(now: float | None = None) -> bool:
    """Delete the vault if its expiry has passed. Needs no key: the expiry is stored in the clear
    (and bound into the encryption, so it can't be changed without breaking decryption)."""
    try:
        data = _read()
    except VaultError:
        return False
    expires = data.get("expires") if data else None
    if isinstance(expires, (int, float)) and (time.time() if now is None else now) >= expires:
        forget()
        return True
    return False


def info() -> dict:
    """What ``promptveil show`` reports about the file itself (no values)."""
    data = _read()
    if not data:
        return {"exists": False}
    enc = data.get("enc")
    return {"exists": True, "encrypted": bool(enc), "key": enc.get("key") if enc else None, "expires": data.get("expires")}


# ---------------------------------------------------------------------------- keys


def _aad(data: dict, key_kind: str) -> bytes:
    header = {"version": data["version"], "created": data["created"], "expires": data["expires"], "key": key_kind}
    return json.dumps(header, sort_keys=True, separators=(",", ":")).encode()


def _scrypt(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    from cryptography.hazmat.primitives.kdf.scrypt import Scrypt

    return Scrypt(salt=salt, length=32, n=n, r=r, p=p).derive(password.encode("utf-8"))


def _secret_tool() -> str:
    exe = shutil.which("secret-tool")
    if not exe:
        raise VaultError(
            "can't encrypt the vault: no keyring found (secret-tool from libsecret isn't installed). "
            "Install it (Fedora: sudo dnf install libsecret), or use --password / PROMPTVEIL_PASSWORD."
        )
    return exe


def _keyring_key(create: bool) -> bytes:
    """The vault key from the OS keyring. The key travels over stdin/stdout, never the command line."""
    exe = _secret_tool()
    try:
        found = subprocess.run([exe, "lookup", *KEYRING_ATTRS], capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.TimeoutExpired):
        raise VaultError("the keyring didn't answer. Use --password / PROMPTVEIL_PASSWORD instead.") from None
    if found.returncode == 0 and found.stdout.strip():
        try:
            key = base64.b64decode(found.stdout.strip(), validate=True)
        except ValueError:
            key = b""
        if len(key) != 32:
            raise VaultError("the PromptVeil key in your keyring is damaged. Run `promptveil forget` to start over.")
        return key
    if not create:
        raise VaultError("the vault's key isn't in your keyring any more. Run `promptveil forget` to start over.")
    key = os.urandom(32)
    try:
        stored = subprocess.run([exe, "store", "--label=PromptVeil vault key", *KEYRING_ATTRS],
                                input=base64.b64encode(key).decode(), capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        stored = None
    if not stored or stored.returncode != 0:
        raise VaultError("couldn't store a key in your keyring (is a keyring unlocked and running?). "
                         "Use --password / PROMPTVEIL_PASSWORD instead.")
    return key


# ---------------------------------------------------------------------------- public API


def load_mapping(password: str | None = None) -> dict[str, str]:
    data = _read()
    if not data:
        return {}
    enc = data.get("enc")
    if not enc:  # plain text: version 1, or version 2 without the secure extra
        mapping = data.get("mapping", {})
        return mapping if isinstance(mapping, dict) else {}
    if not have_crypto():
        raise VaultError("the vault is encrypted: install the secure extra (pip install 'promptveil[secure]').")
    kind = enc.get("key")
    try:
        if kind == "scrypt":
            if not password:
                raise VaultError("the vault is password-protected: use --password or set PROMPTVEIL_PASSWORD.")
            kdf = enc["kdf"]
            key = _scrypt(password, base64.b64decode(kdf["salt"]), int(kdf["n"]), int(kdf["r"]), int(kdf["p"]))
        elif kind == "keyring":
            key = _keyring_key(create=False)
        else:
            raise VaultError(f"the vault file is damaged: {vault_path()}. Run `promptveil forget` to start over.")
        nonce, ct = base64.b64decode(enc["nonce"]), base64.b64decode(enc["ct"])
    except (KeyError, TypeError, ValueError):
        raise VaultError(f"the vault file is damaged: {vault_path()}. Run `promptveil forget` to start over.") from None

    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    try:
        plain = AESGCM(key).decrypt(nonce, ct, _aad(data, kind))
    except InvalidTag:
        if kind == "scrypt":
            raise VaultError("wrong password, or the vault file is damaged.") from None
        raise VaultError("the vault doesn't match the key in your keyring, or the file is damaged.") from None
    mapping = json.loads(plain.decode("utf-8"))
    return mapping if isinstance(mapping, dict) else {}


def save_mapping(mapping: dict[str, str], ttl: int | None = DEFAULT_TTL, password: str | None = None) -> Path:
    """Write the vault. ``ttl`` is seconds until it expires (None: never)."""
    old = _read()
    now = int(time.time())
    data: dict = {
        "version": FORMAT,
        "created": int(old.get("created", now)) if old and isinstance(old.get("created"), (int, float)) else now,
        "expires": now + ttl if ttl else None,
    }
    if not have_crypto():
        if password:
            raise VaultError("--password / PROMPTVEIL_PASSWORD need the secure extra: pip install 'promptveil[secure]'.")
        data["mapping"] = mapping
        _plaintext_note()
    else:
        old_kind = (old.get("enc") or {}).get("key") if old else None
        if password:
            kind, salt = "scrypt", os.urandom(16)
            key = _scrypt(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P)
        elif old_kind == "scrypt":
            raise VaultError("the vault is password-protected: use --password or set PROMPTVEIL_PASSWORD.")
        else:
            kind, key = "keyring", _keyring_key(create=True)
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        nonce = os.urandom(12)
        ct = AESGCM(key).encrypt(nonce, json.dumps(mapping).encode("utf-8"), _aad(data, kind))
        enc = {"alg": "AES-256-GCM", "key": kind, "nonce": base64.b64encode(nonce).decode(),
               "ct": base64.b64encode(ct).decode()}
        if kind == "scrypt":
            enc["kdf"] = {"name": "scrypt", "salt": base64.b64encode(salt).decode(),
                          "n": SCRYPT_N, "r": SCRYPT_R, "p": SCRYPT_P}
        data["enc"] = enc

    p = vault_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    os.replace(tmp, p)
    os.chmod(p, 0o600)
    return p


def _plaintext_note() -> None:
    marker = vault_path().parent / ".plaintext-note-shown"
    if marker.exists():
        return
    print("promptveil: note: the vault is stored as plain text (readable only by you, 0600). "
          "To encrypt it, install the secure extra: pip install 'promptveil[secure]'. "
          "This note is shown once.", file=sys.stderr)
    try:
        marker.parent.mkdir(parents=True, exist_ok=True)
        marker.touch()
    except OSError:
        pass


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
