"""Pattern-based detectors for sensitive data.

Each detector has a ``kind`` (used in placeholders, e.g. ``[EMAIL_1]``), a
compiled regex, a priority (higher wins when matches overlap), an optional
validator, and an optional capture group: when ``group`` is set only that group
is redacted (e.g. the value in ``password = hunter2``), not the whole match.

Keep these in sync with the JavaScript engine in ``web/index.html``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Optional


@dataclass(frozen=True)
class Detector:
    kind: str
    pattern: re.Pattern
    priority: int
    validator: Optional[Callable[[str], bool]] = None
    group: int = 0
    label: str = ""


def luhn_ok(raw: str) -> bool:
    digits = [int(c) for c in raw if c.isdigit()]
    if not 13 <= len(digits) <= 19:
        return False
    total = 0
    for i, d in enumerate(reversed(digits)):
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def ssn_ok(raw: str) -> bool:
    area, group, serial = raw.split("-")
    if area in ("000", "666") or area.startswith("9"):
        return False
    return group != "00" and serial != "0000"


def ipv4_ok(raw: str) -> bool:
    parts = raw.split(".")
    return len(parts) == 4 and all(p.isdigit() and int(p) <= 255 and (p == "0" or not p.startswith("0")) for p in parts)


I = re.IGNORECASE

DETECTORS: list[Detector] = [
    # --- Secrets (highest priority) -------------------------------------------------
    Detector("PRIVATE_KEY", re.compile(
        r"-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]+?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----"),
        100, label="Private key block"),
    Detector("AWS_KEY", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"), 90, label="AWS access key ID"),
    Detector("GITHUB_TOKEN", re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b"),
             90, label="GitHub token"),
    Detector("API_KEY", re.compile(r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}"), 90, label="OpenAI / Anthropic style key"),
    Detector("SLACK_TOKEN", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}"), 90, label="Slack token"),
    Detector("GOOGLE_KEY", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"), 90, label="Google API key"),
    Detector("STRIPE_KEY", re.compile(r"\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b"), 90, label="Stripe key"),
    Detector("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}"), 85, label="JSON Web Token"),
    Detector("PASSWORD", re.compile(
        r"\b[a-z][a-z0-9+.-]*://[^\s:/@]+:([^\s@/]+)@", I), 85, group=1, label="Password in connection URL"),
    Detector("SECRET", re.compile(
        r"""(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|token|client[_-]?secret)"""
        r"""["']?\s*[:=]\s*["']?([^\s"',;]{6,})""", I), 80, group=1, label="Secret in key=value"),
    # --- Personal data ----------------------------------------------------------
    Detector("EMAIL", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"), 70, label="Email address"),
    Detector("CARD", re.compile(r"\b(?:\d[ -]?){12,18}\d\b"), 65, validator=luhn_ok, label="Payment card number"),
    Detector("SSN", re.compile(r"\b\d{3}-\d{2}-\d{4}\b"), 65, validator=ssn_ok, label="US Social Security number"),
    Detector("PHONE", re.compile(
        r"(?<![\w.])(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\w|\.\d)"), 55, label="Phone number"),
    # --- Network identifiers -----------------------------------------------------
    Detector("IP", re.compile(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?!\w|\.\d)"), 60, validator=ipv4_ok, label="IPv4 address"),
    Detector("IPV6", re.compile(r"(?<![\w:])(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}(?![\w:])"), 60, label="IPv6 address"),
    Detector("MAC", re.compile(r"\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b"), 60, label="MAC address"),
    Detector("HOST", re.compile(
        r"\b(?:[A-Za-z0-9-]+\.)+(?:internal|local|lan|corp|intranet|home\.arpa)\b", I), 50,
        label="Internal hostname"),
]

KINDS = {d.kind: d.label for d in DETECTORS} | {"TERM": "Custom term"}
