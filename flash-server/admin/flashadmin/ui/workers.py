"""Run blocking work off the UI thread; results come back as queued Qt signals."""
from __future__ import annotations

import inspect
import traceback
from typing import Any, Callable, Optional

from PySide6.QtCore import QObject, QRunnable, QThreadPool, Signal

POOL = QThreadPool()
POOL.setMaxThreadCount(16)
_LIVE: set = set()


class TaskSignals(QObject):
    done = Signal(object)
    failed = Signal(str)
    progress = Signal(object)
    finished = Signal()


class _Task(QRunnable):
    def __init__(self, fn: Callable, signals: TaskSignals):
        super().__init__()
        self.fn, self.signals = fn, signals
        self.setAutoDelete(True)

    def run(self) -> None:
        try:
            try:
                wants = "progress" in inspect.signature(self.fn).parameters
            except (TypeError, ValueError):
                wants = False
            result = self.fn(progress=self.signals.progress.emit) if wants else self.fn()
        except Exception as e:  # noqa: BLE001 - shown in a banner
            msg = str(e).strip() or type(e).__name__
            if not isinstance(e, (OSError, RuntimeError, ValueError)) and type(e).__name__ not in (
                    "ApiError", "SshError", "HostKeyChanged"):
                traceback.print_exc()
            self.signals.failed.emit(msg)
        else:
            self.signals.done.emit(result)
        finally:
            self.signals.finished.emit()


def run_task(fn: Callable, on_done: Optional[Callable[[Any], None]] = None,
             on_error: Optional[Callable[[str], None]] = None,
             on_progress: Optional[Callable[[Any], None]] = None,
             on_finished: Optional[Callable[[], None]] = None) -> TaskSignals:
    """fn runs in the pool; if it takes a `progress` kwarg it gets a thread-safe emitter."""
    sig = TaskSignals()
    _LIVE.add(sig)
    if on_done:
        sig.done.connect(on_done)
    if on_error:
        sig.failed.connect(on_error)
    if on_progress:
        sig.progress.connect(on_progress)
    if on_finished:
        sig.finished.connect(on_finished)
    sig.finished.connect(lambda: _LIVE.discard(sig))
    POOL.start(_Task(fn, sig))
    return sig


def wait_idle(app, timeout_ms: int = 5000) -> None:
    """Testing / screenshots: wait for pool tasks and deliver their queued signals."""
    POOL.waitForDone(timeout_ms)
    for _ in range(6):
        app.processEvents()
