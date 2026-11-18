"""Line icons drawn with QPainter (no image files, no extra deps). 24-unit grid, stroke style."""
from __future__ import annotations

import math
from typing import Callable, Dict

from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QIcon, QPainter, QPainterPath, QPen, QPixmap


def _home(p: QPainter) -> None:
    path = QPainterPath()
    path.moveTo(3.5, 11)
    path.lineTo(12, 4)
    path.lineTo(20.5, 11)
    p.drawPath(path)
    p.drawRoundedRect(QRectF(6, 10, 12, 10), 2, 2)
    p.drawLine(QPointF(10.5, 20), QPointF(10.5, 15.5))
    p.drawLine(QPointF(10.5, 15.5), QPointF(13.5, 15.5))
    p.drawLine(QPointF(13.5, 15.5), QPointF(13.5, 20))


def _plug(p: QPainter) -> None:
    p.drawLine(QPointF(9, 3), QPointF(9, 7.5))
    p.drawLine(QPointF(15, 3), QPointF(15, 7.5))
    path = QPainterPath()
    path.moveTo(6, 7.5)
    path.lineTo(18, 7.5)
    path.lineTo(18, 11)
    path.cubicTo(18, 14.5, 15.5, 16.5, 12, 16.5)
    path.cubicTo(8.5, 16.5, 6, 14.5, 6, 11)
    path.closeSubpath()
    p.drawPath(path)
    p.drawLine(QPointF(12, 16.5), QPointF(12, 21))


def _rocket(p: QPainter) -> None:
    path = QPainterPath()
    path.moveTo(12, 2.5)
    path.cubicTo(16, 5.5, 16.5, 10.5, 15, 16)
    path.lineTo(9, 16)
    path.cubicTo(7.5, 10.5, 8, 5.5, 12, 2.5)
    p.drawPath(path)
    p.drawEllipse(QPointF(12, 9), 1.6, 1.6)
    w = QPainterPath()
    w.moveTo(9, 12)
    w.lineTo(6, 15)
    w.lineTo(6.5, 18)
    w.lineTo(9, 16)
    p.drawPath(w)
    w2 = QPainterPath()
    w2.moveTo(15, 12)
    w2.lineTo(18, 15)
    w2.lineTo(17.5, 18)
    w2.lineTo(15, 16)
    p.drawPath(w2)
    p.drawLine(QPointF(12, 18.5), QPointF(12, 21.5))


def _transfer(p: QPainter) -> None:
    p.drawLine(QPointF(4, 8), QPointF(18, 8))
    p.drawLine(QPointF(14.5, 4.5), QPointF(18, 8))
    p.drawLine(QPointF(14.5, 11.5), QPointF(18, 8))
    p.drawLine(QPointF(20, 16), QPointF(6, 16))
    p.drawLine(QPointF(9.5, 12.5), QPointF(6, 16))
    p.drawLine(QPointF(9.5, 19.5), QPointF(6, 16))


def _terminal(p: QPainter) -> None:
    p.drawRoundedRect(QRectF(3, 4.5, 18, 15), 3, 3)
    p.drawLine(QPointF(7, 9.5), QPointF(10, 12))
    p.drawLine(QPointF(10, 12), QPointF(7, 14.5))
    p.drawLine(QPointF(12, 15), QPointF(16.5, 15))


def _inbox(p: QPainter) -> None:
    path = QPainterPath()
    path.moveTo(3.5, 13)
    path.lineTo(6.5, 5)
    path.lineTo(17.5, 5)
    path.lineTo(20.5, 13)
    path.lineTo(20.5, 19)
    path.lineTo(3.5, 19)
    path.closeSubpath()
    p.drawPath(path)
    t = QPainterPath()
    t.moveTo(3.5, 13)
    t.lineTo(8.5, 13)
    t.lineTo(10, 15.5)
    t.lineTo(14, 15.5)
    t.lineTo(15.5, 13)
    t.lineTo(20.5, 13)
    p.drawPath(t)


def _store(p: QPainter) -> None:
    for x, y in ((4, 4), (13, 4), (4, 13), (13, 13)):
        p.drawRoundedRect(QRectF(x, y, 7, 7), 2, 2)


def _tag(p: QPainter) -> None:
    path = QPainterPath()
    path.moveTo(3.5, 4.5)
    path.lineTo(11.5, 4.5)
    path.lineTo(20, 13)
    path.lineTo(13, 20)
    path.lineTo(3.5, 11)
    path.closeSubpath()
    p.drawPath(path)
    p.drawEllipse(QPointF(8, 9), 1.5, 1.5)


def _users(p: QPainter) -> None:
    p.drawEllipse(QPointF(9, 8.5), 3.3, 3.3)
    path = QPainterPath()
    path.moveTo(3, 19.5)
    path.cubicTo(3, 15.5, 5.5, 13.5, 9, 13.5)
    path.cubicTo(12.5, 13.5, 15, 15.5, 15, 19.5)
    p.drawPath(path)
    arc = QPainterPath()
    arc.moveTo(15, 5.5)
    arc.cubicTo(18, 5.5, 19, 9.5, 16.5, 11.2)
    p.drawPath(arc)
    arc2 = QPainterPath()
    arc2.moveTo(17, 14)
    arc2.cubicTo(19.5, 14.5, 21, 16.5, 21, 19.5)
    p.drawPath(arc2)


def _bolt(p: QPainter) -> None:
    path = QPainterPath()
    path.moveTo(13.5, 2.5)
    path.lineTo(5.5, 13.5)
    path.lineTo(11.5, 13.5)
    path.lineTo(10.5, 21.5)
    path.lineTo(18.5, 10.5)
    path.lineTo(12.5, 10.5)
    path.closeSubpath()
    p.drawPath(path)


def _refresh(p: QPainter) -> None:
    p.drawArc(QRectF(5, 5, 14, 14), 30 * 16, 290 * 16)
    a = math.radians(30)
    x, y = 12 + 7 * math.cos(a), 12 - 7 * math.sin(a)
    p.drawLine(QPointF(x, y), QPointF(x + 0.5, y - 4))
    p.drawLine(QPointF(x, y), QPointF(x - 3.8, y - 1.2))


def _plus(p: QPainter) -> None:
    p.drawLine(QPointF(12, 5), QPointF(12, 19))
    p.drawLine(QPointF(5, 12), QPointF(19, 12))


def _folder(p: QPainter) -> None:
    path = QPainterPath()
    path.moveTo(3.5, 7)
    path.lineTo(3.5, 18.5)
    path.lineTo(20.5, 18.5)
    path.lineTo(20.5, 8.5)
    path.lineTo(11.5, 8.5)
    path.lineTo(9.5, 5.5)
    path.lineTo(3.5, 5.5)
    path.closeSubpath()
    p.drawPath(path)


def _file(p: QPainter) -> None:
    path = QPainterPath()
    path.moveTo(6, 3.5)
    path.lineTo(14, 3.5)
    path.lineTo(18.5, 8)
    path.lineTo(18.5, 20.5)
    path.lineTo(6, 20.5)
    path.closeSubpath()
    p.drawPath(path)
    p.drawLine(QPointF(14, 3.5), QPointF(14, 8))
    p.drawLine(QPointF(14, 8), QPointF(18.5, 8))


def _up(p: QPainter) -> None:
    p.drawLine(QPointF(12, 19), QPointF(12, 5))
    p.drawLine(QPointF(6.5, 10.5), QPointF(12, 5))
    p.drawLine(QPointF(17.5, 10.5), QPointF(12, 5))


def _upload(p: QPainter) -> None:
    p.drawLine(QPointF(12, 15), QPointF(12, 4))
    p.drawLine(QPointF(7.5, 8.5), QPointF(12, 4))
    p.drawLine(QPointF(16.5, 8.5), QPointF(12, 4))
    path = QPainterPath()
    path.moveTo(4, 14)
    path.lineTo(4, 20)
    path.lineTo(20, 20)
    path.lineTo(20, 14)
    p.drawPath(path)


def _download(p: QPainter) -> None:
    p.drawLine(QPointF(12, 4), QPointF(12, 15))
    p.drawLine(QPointF(7.5, 10.5), QPointF(12, 15))
    p.drawLine(QPointF(16.5, 10.5), QPointF(12, 15))
    path = QPainterPath()
    path.moveTo(4, 14)
    path.lineTo(4, 20)
    path.lineTo(20, 20)
    path.lineTo(20, 14)
    p.drawPath(path)


def _shield(p: QPainter) -> None:
    path = QPainterPath()
    path.moveTo(12, 3)
    path.lineTo(19.5, 6)
    path.cubicTo(19.5, 13, 16.5, 18, 12, 21)
    path.cubicTo(7.5, 18, 4.5, 13, 4.5, 6)
    path.closeSubpath()
    p.drawPath(path)
    p.drawLine(QPointF(8.8, 12), QPointF(11, 14.3))
    p.drawLine(QPointF(11, 14.3), QPointF(15.5, 9.5))


def _database(p: QPainter) -> None:
    p.drawEllipse(QRectF(5, 3.5, 14, 5))
    p.drawLine(QPointF(5, 6), QPointF(5, 18))
    p.drawLine(QPointF(19, 6), QPointF(19, 18))
    p.drawArc(QRectF(5, 15.5, 14, 5), 180 * 16, 180 * 16)
    p.drawArc(QRectF(5, 9.5, 14, 5), 180 * 16, 180 * 16)


def _copy(p: QPainter) -> None:
    p.drawRoundedRect(QRectF(8.5, 8.5, 11.5, 11.5), 2.5, 2.5)
    path = QPainterPath()
    path.moveTo(15.5, 8.5)
    path.lineTo(15.5, 6)
    path.quadTo(15.5, 4, 13.5, 4)
    path.lineTo(6, 4)
    path.quadTo(4, 4, 4, 6)
    path.lineTo(4, 13.5)
    path.quadTo(4, 15.5, 6, 15.5)
    path.lineTo(8.5, 15.5)
    p.drawPath(path)


def _power(p: QPainter) -> None:
    p.drawArc(QRectF(4.5, 5, 15, 15), 120 * 16, -240 * 16)
    p.drawLine(QPointF(12, 3), QPointF(12, 11))


def _restore(p: QPainter) -> None:
    p.drawArc(QRectF(5, 5, 14, 14), 160 * 16, -300 * 16)
    p.drawLine(QPointF(5.2, 9.6), QPointF(4.8, 5.5))
    p.drawLine(QPointF(5.2, 9.6), QPointF(9.2, 9))
    p.drawLine(QPointF(12, 8.5), QPointF(12, 12))
    p.drawLine(QPointF(12, 12), QPointF(14.5, 13.5))


DRAW: Dict[str, Callable[[QPainter], None]] = {
    "home": _home, "plug": _plug, "rocket": _rocket, "transfer": _transfer, "terminal": _terminal,
    "inbox": _inbox, "store": _store, "tag": _tag, "users": _users, "bolt": _bolt, "refresh": _refresh,
    "plus": _plus, "folder": _folder, "file": _file, "up": _up, "upload": _upload, "download": _download,
    "shield": _shield, "database": _database, "copy": _copy, "power": _power, "restore": _restore,
}


def pixmap(name: str, color: QColor | str, size: int = 18, dpr: float = 2.0, width: float = 1.7,
           fill: bool = False) -> QPixmap:
    pm = QPixmap(int(size * dpr), int(size * dpr))
    pm.setDevicePixelRatio(dpr)
    pm.fill(Qt.GlobalColor.transparent)
    p = QPainter(pm)
    p.setRenderHint(QPainter.RenderHint.Antialiasing)
    c = QColor(color)
    pen = QPen(c, width * 24 / size)
    pen.setCapStyle(Qt.PenCapStyle.RoundCap)
    pen.setJoinStyle(Qt.PenJoinStyle.RoundJoin)
    p.setPen(pen)
    if fill:
        p.setBrush(c)
    p.scale(size / 24, size / 24)
    DRAW[name](p)
    p.end()
    return pm


def icon(name: str, color: QColor | str, size: int = 18, active: QColor | str | None = None) -> QIcon:
    ic = QIcon()
    ic.addPixmap(pixmap(name, color, size), QIcon.Mode.Normal, QIcon.State.Off)
    if active is not None:
        ic.addPixmap(pixmap(name, active, size), QIcon.Mode.Normal, QIcon.State.On)
    return ic
