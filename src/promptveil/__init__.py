"""PromptVeil: redact sensitive data before you prompt an AI, restore it after."""

__version__ = "0.1.1"

from .engine import Veil, Finding  # noqa: E402,F401
