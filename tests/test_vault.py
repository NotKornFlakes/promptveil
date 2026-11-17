"""CLI vault: encryption (keyring and password), plain-text fallback, migration, expiry.

PATH is replaced in every test, so the real secret-tool (and your real keyring) is never used:
keyring tests get a fake secret-tool that keeps its secrets in a file.
"""
import io
import json
import os
import stat
import sys
import time

import pytest

from promptveil import vault
from promptveil import cli
from promptveil.cli import main

pytestmark = pytest.mark.skipif(not vault.have_crypto(), reason="needs promptveil[secure] (cryptography)")

FAKE_SECRET_TOOL = """#!{py}
import json, pathlib, sys
db, log = pathlib.Path({db!r}), pathlib.Path({log!r})
with log.open("a") as fh:
    fh.write(json.dumps(sys.argv[1:]) + "\\n")
data = json.loads(db.read_text()) if db.exists() else {{}}
attrs = " ".join(a for a in sys.argv[2:] if not a.startswith("--"))
if sys.argv[1] == "lookup":
    if attrs in data:
        sys.stdout.write(data[attrs]); sys.exit(0)
    sys.exit(1)
if sys.argv[1] == "store":
    data[attrs] = sys.stdin.read().strip(); db.write_text(json.dumps(data)); sys.exit(0)
sys.exit(2)
"""


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("PROMPTVEIL_VAULT", str(tmp_path / "vault.json"))
    monkeypatch.setenv("PROMPTVEIL_CONFIG", str(tmp_path / "cfg"))
    monkeypatch.delenv("PROMPTVEIL_PASSWORD", raising=False)
    (tmp_path / "bin").mkdir()
    monkeypatch.setenv("PATH", str(tmp_path / "bin"))  # no real secret-tool
    monkeypatch.setattr(vault, "SCRYPT_N", 2**10)        # fast scrypt for tests
    return tmp_path


@pytest.fixture
def keyring(env):
    tool = env / "bin" / "secret-tool"
    tool.write_text(FAKE_SECRET_TOOL.format(py=sys.executable, db=str(env / "keyring.json"), log=str(env / "calls.log")))
    tool.chmod(0o755)
    return env


def run(capsys, args, stdin=None, monkeypatch=None):
    if stdin is not None:
        monkeypatch.setattr("sys.stdin", io.StringIO(stdin))
    code = main(args)
    out, err = capsys.readouterr()
    return code, out, err


def vault_json(env):
    return json.loads((env / "vault.json").read_text())


def test_keyring_round_trip_key_never_on_command_line(keyring, capsys, monkeypatch):
    code, out, err = run(capsys, ["scrub"], "mail ops@corp.example.com about 10.9.9.9.", monkeypatch)
    assert code == 0 and out == "mail [EMAIL_1] about [IP_1]."
    data = vault_json(keyring)
    assert data["enc"]["alg"] == "AES-256-GCM" and data["enc"]["key"] == "keyring" and "mapping" not in data
    raw = (keyring / "vault.json").read_text()
    assert "ops@corp.example.com" not in raw and "10.9.9.9" not in raw
    assert stat.S_IMODE(os.stat(keyring / "vault.json").st_mode) == 0o600

    code, out, _ = run(capsys, ["restore"], "Done: emailed EMAIL_1 re [IP_1].", monkeypatch)
    assert code == 0 and out == "Done: emailed ops@corp.example.com re 10.9.9.9."

    key = json.loads((keyring / "keyring.json").read_text())["service promptveil key vault"]
    calls = (keyring / "calls.log").read_text()
    assert key not in calls  # passed on stdin/stdout only, never as an argument


def test_password_round_trip_and_wrong_password(env, capsys, monkeypatch):
    monkeypatch.setenv("PROMPTVEIL_PASSWORD", "correct horse battery")
    code, out, _ = run(capsys, ["scrub"], "key AKIAIOSFODNN7EXAMPLE", monkeypatch)
    assert code == 0 and out == "key [AWS_KEY_1]"
    enc = vault_json(env)["enc"]
    assert enc["key"] == "scrypt" and enc["kdf"]["name"] == "scrypt" and len(enc["kdf"]["salt"]) >= 22
    assert "AKIAIOSFODNN7EXAMPLE" not in (env / "vault.json").read_text()

    code, out, _ = run(capsys, ["restore"], "rotate [AWS_KEY_1]", monkeypatch)
    assert code == 0 and out == "rotate AKIAIOSFODNN7EXAMPLE"

    monkeypatch.setenv("PROMPTVEIL_PASSWORD", "wrong horse battery")
    code, out, err = run(capsys, ["restore"], "rotate [AWS_KEY_1]", monkeypatch)
    assert code == 2 and out == ""
    assert err == "promptveil: wrong password, or the vault file is damaged.\n"


def test_password_vault_needs_the_password(env, capsys, monkeypatch):
    monkeypatch.setenv("PROMPTVEIL_PASSWORD", "correct horse battery")
    run(capsys, ["scrub"], "mail a@b.co", monkeypatch)
    monkeypatch.delenv("PROMPTVEIL_PASSWORD")
    code, _, err = run(capsys, ["restore"], "x", monkeypatch)
    assert code == 2 and "password-protected" in err and "Traceback" not in err
    code, out, err = run(capsys, ["scrub"], "mail c@d.co", monkeypatch)  # can't silently switch to the keyring
    assert code == 2 and out == "" and "password-protected" in err


def test_password_prompt_asks_twice_for_a_new_vault(env, capsys, monkeypatch):
    answers = iter(["first try 123", "first try 124"])
    monkeypatch.setattr(cli, "open", lambda *a, **k: open(os.devnull), raising=False)  # pretend there's a terminal
    monkeypatch.setattr(cli.getpass, "getpass", lambda prompt="": next(answers))
    code, out, err = run(capsys, ["scrub", "--password"], "mail a@b.co", monkeypatch)
    assert code == 2 and out == "" and "don't match" in err and not (env / "vault.json").exists()


def test_no_keyring_and_no_password_refuses_and_prints_nothing(env, capsys, monkeypatch):
    code, out, err = run(capsys, ["scrub"], "mail a@b.co", monkeypatch)
    assert code == 2 and out == ""  # never hand out text that could not be restored
    assert "no keyring found" in err and "PROMPTVEIL_PASSWORD" in err
    assert not (env / "vault.json").exists()  # and never fall back to plain text


def test_plain_vault_is_migrated_to_encrypted(keyring, capsys, monkeypatch):
    (keyring / "vault.json").write_text(json.dumps({"version": 1, "mapping": {"IP_1": "10.9.9.9"}}))
    code, out, _ = run(capsys, ["scrub"], "and 10.1.1.1", monkeypatch)
    assert code == 0 and out == "and [IP_2]"
    data = vault_json(keyring)
    assert "mapping" not in data and data["enc"]["key"] == "keyring"
    code, out, _ = run(capsys, ["restore"], "IP_1 and IP_2", monkeypatch)
    assert out == "10.9.9.9 and 10.1.1.1"


def test_tampering_with_the_expiry_is_detected(keyring, capsys, monkeypatch):
    run(capsys, ["scrub", "--ttl", "1h"], "mail a@b.co", monkeypatch)
    data = vault_json(keyring)
    data["expires"] += 10**6
    (keyring / "vault.json").write_text(json.dumps(data))
    code, _, err = run(capsys, ["restore"], "x", monkeypatch)
    assert code == 2 and "doesn't match" in err


def test_damaged_file(env, capsys, monkeypatch):
    (env / "vault.json").write_text("not json")
    code, _, err = run(capsys, ["restore"], "x", monkeypatch)
    assert code == 2 and "damaged" in err and "Traceback" not in err


def test_ttl_option_sets_expiry_and_expired_vault_is_deleted(keyring, capsys, monkeypatch):
    before = time.time()
    run(capsys, ["scrub", "--ttl", "2h"], "mail a@b.co", monkeypatch)
    expires = vault_json(keyring)["expires"]
    assert before + 7200 - 2 <= expires <= time.time() + 7200 + 2

    monkeypatch.setattr(vault.time, "time", lambda: expires + 1)
    code, out, err = run(capsys, ["show"], None, monkeypatch)
    assert code == 0 and "expired and was deleted" in err and out == "(vault is empty)\n"
    assert not (keyring / "vault.json").exists()


@pytest.mark.parametrize("config, expected", [(None, 24 * 3600), ("ttl = 30m", 1800), ("ttl = never", None)])
def test_default_ttl_from_config(keyring, capsys, monkeypatch, config, expected):
    if config:
        (keyring / "cfg").mkdir()
        (keyring / "cfg" / "config.ini").write_text(f"[vault]\n{config}\n")
    run(capsys, ["scrub"], "mail a@b.co", monkeypatch)
    expires = vault_json(keyring)["expires"]
    if expected is None:
        assert expires is None
    else:
        assert abs(expires - (time.time() + expected)) < 5


@pytest.mark.parametrize("bad", ["soon", "0h", "5 weeks", "-1h"])
def test_invalid_ttl_is_rejected(env, capsys, bad):
    with pytest.raises(SystemExit) as e:
        main(["scrub", "--ttl", bad])
    assert e.value.code == 2


def test_show_masked_unless_reveal(keyring, capsys, monkeypatch):
    run(capsys, ["scrub"], "mail ops@corp.example.com", monkeypatch)
    code, out, err = run(capsys, ["show"], None, monkeypatch)
    assert "ops@corp.example.com" not in out and "op" in out and "encrypted, key in your keyring" in err
    code, out, _ = run(capsys, ["show", "--reveal"], None, monkeypatch)
    assert "ops@corp.example.com" in out


def test_without_the_extra_plain_text_with_a_one_time_note(env, capsys, monkeypatch):
    monkeypatch.setattr(vault, "have_crypto", lambda: False)
    code, out, err = run(capsys, ["scrub"], "mail a@b.co", monkeypatch)
    assert code == 0 and out == "mail [EMAIL_1]"
    assert "stored as plain text" in err and "promptveil[secure]" in err
    assert vault_json(env)["mapping"] == {"EMAIL_1": "a@b.co"}
    _, _, err = run(capsys, ["scrub"], "mail c@d.co", monkeypatch)
    assert "plain text" not in err  # shown once


def test_password_without_the_extra_is_an_error(env, capsys, monkeypatch):
    monkeypatch.setattr(vault, "have_crypto", lambda: False)
    monkeypatch.setenv("PROMPTVEIL_PASSWORD", "correct horse battery")
    code, out, err = run(capsys, ["scrub"], "mail a@b.co", monkeypatch)
    assert code == 2 and out == "" and "secure extra" in err
