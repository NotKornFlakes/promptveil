"""Core scrub / restore logic.

A :class:`Veil` holds the mapping between real values and placeholders. The same
value always maps to the same placeholder within a session, so the AI can still
reason about relationships ("PERSON_1 emailed EMAIL_2") without seeing the data.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .detectors import DETECTORS


@dataclass
class Finding:
    kind: str
    value: str
    start: int
    end: int
    priority: int


@dataclass
class Veil:
    # placeholder -> original value
    mapping: dict[str, str] = field(default_factory=dict)
    terms: list[str] = field(default_factory=list)
    allow: list[str] = field(default_factory=list)

    # ------------------------------------------------------------------ detection
    def find(self, text: str) -> list[Finding]:
        found: list[Finding] = []
        allow = {a.lower() for a in self.allow}

        for d in DETECTORS:
            for m in d.pattern.finditer(text):
                value = m.group(d.group)
                if not value or value.lower() in allow:
                    continue
                if d.validator and not d.validator(value):
                    continue
                found.append(Finding(d.kind, value, m.start(d.group), m.end(d.group), d.priority))

        for term in sorted({t.strip() for t in self.terms if t.strip()}, key=len, reverse=True):
            pat = re.compile(r"(?<!\w)" + re.escape(term) + r"(?!\w)", re.IGNORECASE)
            for m in pat.finditer(text):
                found.append(Finding("TERM", m.group(0), m.start(), m.end(), 95))

        # Resolve overlaps: higher priority first, then longer span, then earlier.
        found.sort(key=lambda f: (-f.priority, -(f.end - f.start), f.start))
        chosen: list[Finding] = []
        for f in found:
            if all(f.end <= c.start or f.start >= c.end for c in chosen):
                chosen.append(f)
        chosen.sort(key=lambda f: f.start)
        return chosen

    # --------------------------------------------------------------- placeholders
    def _placeholder_for(self, kind: str, value: str) -> str:
        key = value.lower() if kind in ("EMAIL", "HOST", "TERM") else value
        for ph, v in self.mapping.items():
            existing = v.lower() if kind in ("EMAIL", "HOST", "TERM") else v
            if existing == key and ph.startswith(kind + "_"):
                return ph
        n = 1 + sum(1 for ph in self.mapping if re.fullmatch(re.escape(kind) + r"_\d+", ph))
        ph = f"{kind}_{n}"
        self.mapping[ph] = value
        return ph

    # ---------------------------------------------------------------- public API
    def scrub(self, text: str) -> tuple[str, list[Finding]]:
        findings = self.find(text)
        out, last = [], 0
        for f in findings:
            out.append(text[last:f.start])
            out.append(f"[{self._placeholder_for(f.kind, f.value)}]")
            last = f.end
        out.append(text[last:])
        return "".join(out), findings

    def restore(self, text: str) -> tuple[str, int]:
        """Put real values back. Accepts ``[EMAIL_1]`` and bare ``EMAIL_1``
        (models sometimes drop the brackets)."""
        if not self.mapping:
            return text, 0
        names = sorted(self.mapping, key=len, reverse=True)
        pat = re.compile(r"\[(" + "|".join(map(re.escape, names)) + r")\]|\b(" +
                         "|".join(map(re.escape, names)) + r")\b")
        count = 0

        def sub(m: re.Match) -> str:
            nonlocal count
            count += 1
            return self.mapping[m.group(1) or m.group(2)]

        return pat.sub(sub, text), count
