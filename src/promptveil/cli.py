"""promptveil command line interface.

    wl-paste | promptveil scrub | wl-copy      # scrub clipboard before pasting into an AI
    wl-paste | promptveil restore | wl-copy    # put real values back into the AI's answer
    promptveil scan notes.md config.yaml       # report only; exit 1 if anything found
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import __version__
from .detectors import KINDS
from .engine import Veil
from . import vault


def _read(path: str | None) -> str:
    if path in (None, "-"):
        return sys.stdin.read()
    return Path(path).read_text(encoding="utf-8")


def _mask(value: str) -> str:
    value = value.replace("\n", " ")
    if len(value) <= 4:
        return "*" * len(value)
    return value[:2] + "*" * min(len(value) - 4, 12) + value[-2:]


def _veil(args, with_mapping: bool) -> Veil:
    terms = vault.read_list("terms.txt") + list(args.term or [])
    for f in args.terms_file or []:
        terms += vault.read_list_file(Path(f))
    allow = vault.read_list("allow.txt") + list(getattr(args, "allow", None) or [])
    mapping = vault.load_mapping() if with_mapping else {}
    return Veil(mapping=mapping, terms=terms, allow=allow)


def _summary(findings) -> str:
    counts: dict[str, int] = {}
    for f in findings:
        counts[f.kind] = counts.get(f.kind, 0) + 1
    if not counts:
        return "promptveil: nothing sensitive found"
    parts = ", ".join(f"{n} {KINDS.get(k, k).lower()}" for k, n in sorted(counts.items(), key=lambda kv: -kv[1]))
    return f"promptveil: redacted {len(findings)} item(s): {parts}"


def cmd_scrub(args) -> int:
    v = _veil(args, with_mapping=not args.new)
    text = _read(args.file)
    out, findings = v.scrub(text)
    sys.stdout.write(out)
    if not args.dry_run:
        vault.save_mapping(v.mapping)
    if not args.quiet:
        print(_summary(findings), file=sys.stderr)
    return 0


def cmd_restore(args) -> int:
    v = Veil(mapping=vault.load_mapping())
    if not v.mapping:
        print("promptveil: vault is empty, nothing to restore (did you run scrub first?)", file=sys.stderr)
    out, n = v.restore(_read(args.file))
    sys.stdout.write(out)
    if not args.quiet:
        print(f"promptveil: restored {n} placeholder(s)", file=sys.stderr)
    return 0


def cmd_scan(args) -> int:
    v = _veil(args, with_mapping=False)
    total = 0
    for path in args.files or ["-"]:
        try:
            text = _read(path)
        except (UnicodeDecodeError, IsADirectoryError):
            continue
        for f in v.find(text):
            line = text.count("\n", 0, f.start) + 1
            name = "<stdin>" if path == "-" else path
            print(f"{name}:{line}: {f.kind:<12} {_mask(f.value)}")
            total += 1
    print(f"promptveil: {total} finding(s)", file=sys.stderr)
    return 1 if total else 0


def cmd_show(args) -> int:
    mapping = vault.load_mapping()
    if not mapping:
        print("(vault is empty)")
    for ph, val in mapping.items():
        print(f"[{ph}]\t{val if args.reveal else _mask(val)}")
    print(f"vault: {vault.vault_path()}", file=sys.stderr)
    return 0


def cmd_forget(args) -> int:
    print("promptveil: vault deleted" if vault.forget() else "promptveil: no vault to delete", file=sys.stderr)
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="promptveil", description="Redact sensitive data before you prompt an AI. Runs 100%% locally.")
    p.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)

    def word_opts(sp):
        sp.add_argument("-t", "--term", action="append", help="extra word/phrase to always redact (repeatable)")
        sp.add_argument("--terms-file", action="append", help="file with one term per line")
        sp.add_argument("-a", "--allow", action="append", help="value to never redact (repeatable)")

    s = sub.add_parser("scrub", help="replace sensitive values with placeholders")
    s.add_argument("file", nargs="?", help="input file (default: stdin)")
    word_opts(s)
    s.add_argument("--new", action="store_true", help="start a fresh mapping instead of extending the vault")
    s.add_argument("--dry-run", action="store_true", help="don't write the vault")
    s.add_argument("-q", "--quiet", action="store_true")
    s.set_defaults(func=cmd_scrub)

    r = sub.add_parser("restore", help="swap placeholders back to real values")
    r.add_argument("file", nargs="?", help="input file (default: stdin)")
    r.add_argument("-q", "--quiet", action="store_true")
    r.set_defaults(func=cmd_restore)

    c = sub.add_parser("scan", help="report findings only; exit 1 if any (good for pre-commit/CI)")
    c.add_argument("files", nargs="*")
    word_opts(c)
    c.set_defaults(func=cmd_scan)

    sh = sub.add_parser("show", help="list the placeholders in the vault")
    sh.add_argument("--reveal", action="store_true", help="show real values instead of masked ones")
    sh.set_defaults(func=cmd_show)

    f = sub.add_parser("forget", help="delete the local vault")
    f.set_defaults(func=cmd_forget)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
