"""
A tiny self-report board for the background jobs, shown by GET /api/health?debug=1.

Why: "are the cheap Firestore queries actually in use, or did they silently fall back to scanning
everything because an index is missing?" and "is Redis really connected?" used to need Render's
logs. Now each job records what it did on its last pass here, and the health endpoint prints it.
No secrets, no Firestore reads — just a dict in memory (per server process).
"""
import threading
from datetime import datetime, timezone

_lock = threading.Lock()
_board = {}


def record(name, **fields):
    with _lock:
        _board[name] = {**fields, "at": datetime.now(timezone.utc).isoformat(timespec="seconds")}


def snapshot():
    with _lock:
        return {k: dict(v) for k, v in _board.items()}
