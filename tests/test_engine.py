import json
import os
import stat
from pathlib import Path

import pytest

from promptveil import Veil, vault
from promptveil.cli import main

SAMPLE = """Hi team, customer Jane Doe (jane.doe@acme.com, 555-867-5309) reported login failures.
Her card 4111 1111 1111 1111 was charged twice. SSN on file: 123-45-6789.
Server db01.corp at 10.0.4.12 logs show key AKIAIOSFODNN7EXAMPLE and
password = Sup3rS3cret! in config. Reply to JANE.DOE@acme.com.
DB: postgres://admin:hunter2pass@10.0.4.12:5432/prod
"""


def kinds(findings):
    return [f.kind for f in findings]


def test_detects_everything_in_sample():
    v = Veil()
    out, findings = v.scrub(SAMPLE)
    k = set(kinds(findings))
    assert {"EMAIL", "PHONE", "CARD", "SSN", "HOST", "IP", "AWS_KEY", "SECRET", "PASSWORD"} <= k
    for secret in ["jane.doe@acme.com", "4111 1111 1111 1111", "123-45-6789", "10.0.4.12",
                   "AKIAIOSFODNN7EXAMPLE", "Sup3rS3cret!", "hunter2pass", "db01.corp", "555-867-5309"]:
        assert secret.lower() not in out.lower(), secret


def test_same_value_same_placeholder_case_insensitive_email():
    v = Veil()
    out, _ = v.scrub(SAMPLE)
    assert out.count("[EMAIL_1]") == 2
    assert out.count("[IP_1]") == 2
    assert "[EMAIL_2]" not in out


def test_round_trip_restores_exact_original_values():
    v = Veil()
    out, _ = v.scrub("Email bob@x.io or call 212-555-0199 from 192.168.1.20")
    ai_answer = f"Sure. I'll email [EMAIL_1] and call PHONE_1 about IP_1."
    restored, n = v.restore(ai_answer)
    assert restored == "Sure. I'll email bob@x.io and call 212-555-0199 about 192.168.1.20."
    assert n == 3


def test_placeholders_stay_consistent_across_calls():
    v = Veil()
    a, _ = v.scrub("ping 10.1.1.1")
    b, _ = v.scrub("then 10.2.2.2 and 10.1.1.1 again")
    assert a == "ping [IP_1]"
    assert b == "then [IP_2] and [IP_1] again"


def test_restore_does_not_touch_longer_names():
    v = Veil(mapping={"IP_1": "10.0.0.1"})
    out, _ = v.restore("IP_1 vs IP_10 vs [IP_1]")
    assert out == "10.0.0.1 vs IP_10 vs 10.0.0.1"


@pytest.mark.parametrize("bad", [
    "4111 1111 1111 1112",   # fails Luhn
    "000-12-3456",           # invalid SSN area
    "999.10.10.10",          # invalid IP
    "version 1.2.3.4.5",     # dotted version string
])
def test_false_positives_rejected(bad):
    assert Veil().find(bad) == []


CASES = json.loads((Path(__file__).parent / "detector_cases.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", CASES["hidden"], ids=lambda c: c["text"])
def test_shared_cases_hidden(case):
    assert [[f.kind, f.value] for f in Veil().find(case["text"])] == case["findings"]


@pytest.mark.parametrize("text", CASES["kept"])
def test_shared_cases_kept(text):
    assert Veil().find(text) == []


def test_custom_terms_and_allow_list():
    v = Veil(terms=["Project Falcon", "Acme"], allow=["10.0.0.1"])
    out, _ = v.scrub("Acme's project falcon runs on 10.0.0.1")
    assert out == "[TERM_1]'s [TERM_2] runs on 10.0.0.1"


def test_private_key_block():
    pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\nAAAA\n-----END OPENSSH PRIVATE KEY-----"
    out, f = Veil().scrub(f"key:\n{pem}\nend")
    assert out == "key:\n[PRIVATE_KEY_1]\nend"


def test_tokens():
    text = ("ghp_" + "a" * 36 + " sk-ant-" + "b" * 30 + " xoxb-1234567890-abc "
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijk")
    k = kinds(Veil().find(text))
    assert k == ["GITHUB_TOKEN", "API_KEY", "SLACK_TOKEN", "JWT"]


def test_plain_text_untouched():
    text = "The quarterly meeting is at 3pm in room 204. Bring 2 copies."
    assert Veil().scrub(text)[0] == text


# ------------------------------------------------------------------- CLI


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("PROMPTVEIL_VAULT", str(tmp_path / "vault.json"))
    monkeypatch.setenv("PROMPTVEIL_CONFIG", str(tmp_path / "cfg"))
    monkeypatch.delenv("PROMPTVEIL_PASSWORD", raising=False)
    monkeypatch.setenv("PATH", str(tmp_path))  # never the real keyring
    # These tests cover the plain-text vault (no secure extra); tests/test_vault.py covers encryption.
    monkeypatch.setattr(vault, "have_crypto", lambda: False)
    return tmp_path


def test_cli_scrub_restore_cycle(env, capsys, monkeypatch):
    src = env / "in.txt"
    src.write_text("mail ops@corp.example.com about 10.9.9.9")
    assert main(["scrub", str(src)]) == 0
    scrubbed = capsys.readouterr().out
    assert scrubbed == "mail [EMAIL_1] about [IP_1]"

    vault_file = env / "vault.json"
    assert stat.S_IMODE(os.stat(vault_file).st_mode) == 0o600
    assert json.loads(vault_file.read_text())["mapping"]["IP_1"] == "10.9.9.9"

    ans = env / "ans.txt"
    ans.write_text("Done: emailed EMAIL_1 re [IP_1].")
    main(["restore", str(ans)])
    assert capsys.readouterr().out == "Done: emailed ops@corp.example.com re 10.9.9.9."

    main(["forget"])
    assert not vault_file.exists()


def test_cli_scan_exit_codes(env, capsys):
    clean = env / "clean.md"
    clean.write_text("nothing to see")
    dirty = env / "dirty.md"
    dirty.write_text("line1\napi_key: abcdef123456\n")
    assert main(["scan", str(clean)]) == 0
    assert main(["scan", str(clean), str(dirty)]) == 1
    out = capsys.readouterr().out
    assert "dirty.md:2: SECRET" in out
    assert "abcdef123456" not in out  # masked


def test_cli_terms_file_from_config(env, capsys):
    cfg = env / "cfg"
    cfg.mkdir()
    (cfg / "terms.txt").write_text("# clients\nGlobex\n")
    src = env / "a.txt"
    src.write_text("Globex contract")
    main(["scrub", "--dry-run", str(src)])
    assert capsys.readouterr().out == "[TERM_1] contract"
