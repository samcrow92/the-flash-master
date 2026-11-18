"""Palette mirrored from src/renderer/styles.css, rendered as a Qt stylesheet (dark + light)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Tuple

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QFont, QFontDatabase, QGuiApplication, QPalette


def _rgb(hexstr: str) -> Tuple[int, int, int]:
    h = hexstr.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


@dataclass
class Theme:
    name: str
    win_base: str
    fg: str
    muted: str
    accent: str
    accent2: str
    accent_fg: str
    blue: str
    green: str
    amber: str
    red: str
    # (r, g, b, alpha 0..1) translucent layers, as in styles.css
    glass: Tuple[int, int, int, float]
    glass_side: Tuple[int, int, int, float]
    glass_strong: Tuple[int, int, int, float]
    field_bg: Tuple[int, int, int, float]
    bg3: Tuple[int, int, int, float]
    line: Tuple[int, int, int, float]
    rim: Tuple[int, int, int, float]
    code: Tuple[int, int, int, float]
    wallpaper: List[Tuple[float, float, float, Tuple[int, int, int, float]]] = field(default_factory=list)
    terminal_bg: str = "#0f1118"
    terminal_fg: str = "#e6e8ef"

    @property
    def dark(self) -> bool:
        return self.name == "dark"

    def qcolor(self, name: str) -> QColor:
        v = getattr(self, name)
        if isinstance(v, tuple):
            r, g, b, a = v
            return QColor(r, g, b, int(a * 255))
        return QColor(v)


def rgba(c, alpha: float = None) -> str:
    """'#rrggbb' or (r,g,b,a) → Qt `rgba(r, g, b, A)` with A in 0..255."""
    if isinstance(c, tuple):
        r, g, b, a = c
    else:
        r, g, b = _rgb(c)
        a = 1.0
    if alpha is not None:
        a = alpha
    return f"rgba({r}, {g}, {b}, {int(round(a * 255))})"


DARK = Theme(
    name="dark", win_base="#0c0e15", fg="#f1f2f6", muted="#9aa0b4",
    accent="#ffcc00", accent2="#ff8a00", accent_fg="#1a1400",
    blue="#64a8ff", green="#34d07f", amber="#ffb340", red="#ff6069",
    glass=(30, 32, 42, .52), glass_side=(24, 26, 36, .46), glass_strong=(34, 36, 48, .86),
    field_bg=(0, 0, 0, .22), bg3=(255, 255, 255, .08), line=(255, 255, 255, .08), rim=(255, 255, 255, .13),
    code=(0, 0, 0, .3),
    wallpaper=[(0.08, -0.10, 0.80, (120, 80, 255, .42)), (1.0, 0.0, 0.62, (0, 170, 255, .30)),
               (0.85, 1.10, 0.70, (255, 150, 40, .26)), (0.0, 1.0, 0.58, (255, 60, 140, .20))],
    terminal_bg="#0d0f16", terminal_fg="#e6e8ef",
)

LIGHT = Theme(
    name="light", win_base="#eef0f6", fg="#1d1d1f", muted="#6e6e78",
    accent="#e0a500", accent2="#f07000", accent_fg="#1a1400",
    blue="#007aff", green="#28b463", amber="#c27a00", red="#e5383b",
    glass=(255, 255, 255, .58), glass_side=(250, 250, 253, .50), glass_strong=(252, 252, 254, .92),
    field_bg=(255, 255, 255, .62), bg3=(0, 0, 0, .05), line=(0, 0, 0, .08), rim=(255, 255, 255, .75),
    code=(0, 0, 0, .045),
    wallpaper=[(0.08, -0.10, 0.80, (150, 120, 255, .38)), (1.0, 0.0, 0.62, (80, 190, 255, .32)),
               (0.85, 1.10, 0.70, (255, 190, 90, .34)), (0.0, 1.0, 0.58, (255, 120, 180, .24))],
    terminal_bg="#fbfbfd", terminal_fg="#1d1d1f",
)

UI_FONTS = ["Segoe UI Variable Text", "Segoe UI", "SF Pro Text", ".AppleSystemUIFont", "Helvetica Neue",
            "Inter", "Cantarell", "Ubuntu", "Noto Sans", "DejaVu Sans"]
MONO_FONTS = ["Cascadia Code", "Cascadia Mono", "SF Mono", "Menlo", "JetBrains Mono", "Consolas",
              "Ubuntu Mono", "DejaVu Sans Mono", "Liberation Mono"]


def pick_family(candidates: List[str]) -> str:
    have = set(QFontDatabase.families())
    for c in candidates:
        if c in have:
            return c
    return QFontDatabase.systemFont(QFontDatabase.SystemFont.GeneralFont).family()


def mono_font(size: float = 12.5) -> QFont:
    f = QFont(pick_family(MONO_FONTS))
    f.setStyleHint(QFont.StyleHint.Monospace)
    f.setPointSizeF(size * 0.75)
    f.setPixelSize(int(round(size)))
    return f


def system_is_dark() -> bool:
    hints = QGuiApplication.styleHints()
    try:
        scheme = hints.colorScheme()
        if scheme == Qt.ColorScheme.Dark:
            return True
        if scheme == Qt.ColorScheme.Light:
            return False
    except AttributeError:
        pass
    return QGuiApplication.palette().color(QPalette.ColorRole.Window).lightness() < 128


def palette_for(t: Theme) -> QPalette:
    p = QPalette()
    fg, base = QColor(t.fg), QColor(t.win_base)
    p.setColor(QPalette.ColorRole.Window, base)
    p.setColor(QPalette.ColorRole.WindowText, fg)
    p.setColor(QPalette.ColorRole.Base, QColor(t.glass_strong[0], t.glass_strong[1], t.glass_strong[2]))
    p.setColor(QPalette.ColorRole.AlternateBase, base)
    p.setColor(QPalette.ColorRole.Text, fg)
    p.setColor(QPalette.ColorRole.Button, base)
    p.setColor(QPalette.ColorRole.ButtonText, fg)
    p.setColor(QPalette.ColorRole.Highlight, QColor(t.accent))
    p.setColor(QPalette.ColorRole.HighlightedText, QColor(t.accent_fg))
    p.setColor(QPalette.ColorRole.PlaceholderText, QColor(t.muted))
    p.setColor(QPalette.ColorRole.ToolTipBase, QColor(t.glass_strong[0], t.glass_strong[1], t.glass_strong[2]))
    p.setColor(QPalette.ColorRole.ToolTipText, fg)
    p.setColor(QPalette.ColorRole.Link, QColor(t.blue))
    return p


def stylesheet(t: Theme) -> str:
    sel = rgba(t.accent, .16 if t.dark else .22)
    sel_strong = rgba(t.accent, .26 if t.dark else .30)
    pill = {k: (getattr(t, k)) for k in ("green", "amber", "red", "blue", "muted", "accent")}
    pills = "\n".join(
        f'QLabel[pill="{k}"] {{ background: {rgba(v, .16)}; color: {v}; border: 1px solid {rgba(v, .32)}; '
        f'border-radius: 10px; padding: 2px 10px; font-size: 11.5px; font-weight: 600; }}'
        for k, v in pill.items())
    banners = "\n".join(
        f'QFrame#banner[kind="{k}"] {{ background: {rgba(v, .13)}; border: 1px solid {rgba(v, .35)}; border-radius: 10px; }}\n'
        f'QFrame#banner[kind="{k}"] QLabel#bannerIcon {{ color: {v}; }}'
        for k, v in (("error", t.red), ("warn", t.amber), ("info", t.blue), ("ok", t.green)))
    return f"""
* {{ outline: none; }}
QWidget {{ color: {t.fg}; font-size: 13px; }}
QMainWindow, QDialog {{ background: {t.win_base}; }}
QDialog {{ background: {rgba(t.glass_strong, 1)}; }}
QToolTip {{ background: {rgba(t.glass_strong, 1)}; color: {t.fg}; border: 1px solid {rgba(t.rim)}; border-radius: 6px; padding: 5px 8px; }}
QLabel {{ background: transparent; }}
QLabel#h1 {{ font-size: 24px; font-weight: 650; }}
QLabel#h2 {{ font-size: 15px; font-weight: 600; }}
QLabel#subtitle {{ color: {t.muted}; font-size: 13px; }}
QLabel#muted, QLabel[muted="true"] {{ color: {t.muted}; }}
QLabel#small {{ color: {t.muted}; font-size: 11.5px; }}
QLabel#section {{ color: {t.muted}; font-size: 11px; font-weight: 600; letter-spacing: 1px; }}
QLabel#stat {{ font-size: 28px; font-weight: 650; }}
QLabel#statLabel {{ color: {t.muted}; font-size: 12px; }}
QLabel#brand {{ font-size: 15px; font-weight: 700; }}
QLabel#bolt {{ color: {t.accent}; font-size: 20px; }}
QLabel#token {{ background: {rgba(t.code)}; border: 1px dashed {rgba(t.accent, .55)}; border-radius: 8px; padding: 10px 12px; font-size: 14px; color: {t.accent if t.dark else t.fg}; }}
QLabel#badge {{ background: {t.accent}; color: {t.accent_fg}; border-radius: 10px; padding: 0px 7px; font-size: 11px; font-weight: 700; }}
{pills}
{banners}
QFrame#sidebar {{ background: {rgba(t.glass_side)}; border: 1px solid {rgba(t.rim)}; border-radius: 18px; }}
QFrame#card {{ background: {rgba(t.glass)}; border: 1px solid {rgba(t.rim)}; border-radius: 14px; }}
QFrame#card[flat="true"] {{ background: {rgba(t.bg3)}; border: 1px solid {rgba(t.line)}; border-radius: 12px; }}
QFrame#card[selected="true"] {{ background: {sel}; border: 1px solid {rgba(t.accent, .55)}; }}
QFrame#sep {{ background: {rgba(t.line)}; max-height: 1px; min-height: 1px; border: none; }}
QFrame#vsep {{ background: {rgba(t.line)}; max-width: 1px; min-width: 1px; border: none; }}
QFrame#connCard {{ background: {rgba(t.bg3)}; border: 1px solid {rgba(t.line)}; border-radius: 12px; }}
QToolButton#nav {{ background: transparent; border: none; border-radius: 10px; padding: 9px 12px; text-align: left; font-size: 13.5px; color: {t.fg}; }}
QToolButton#nav:hover {{ background: {rgba(t.bg3)}; }}
QToolButton#nav:checked {{ background: {sel}; font-weight: 600; }}
QPushButton, QToolButton {{ background: {rgba(t.bg3)}; border: 1px solid {rgba(t.line)}; border-radius: 8px; padding: 7px 14px; color: {t.fg}; }}
QPushButton:hover, QToolButton:hover {{ border-color: {rgba(t.muted, .7)}; }}
QPushButton:pressed {{ background: {rgba(t.line)}; }}
QPushButton:disabled {{ color: {rgba(t.muted, .6)}; border-color: {rgba(t.line)}; }}
QPushButton[kind="primary"] {{ background: qlineargradient(x1:0, y1:0, x2:1, y2:1, stop:0 {t.accent}, stop:1 {t.accent2}); color: {t.accent_fg}; border: none; font-weight: 650; padding: 8px 18px; }}
QPushButton[kind="primary"]:hover {{ background: qlineargradient(x1:0, y1:0, x2:1, y2:1, stop:0 {t.accent}, stop:1 {t.accent}); }}
QPushButton[kind="primary"]:disabled {{ background: {rgba(t.accent, .35)}; color: {rgba(t.accent_fg, .6)}; }}
QPushButton[kind="danger"] {{ color: {t.red}; border-color: {rgba(t.red, .4)}; }}
QPushButton[kind="danger"]:hover {{ background: {rgba(t.red, .12)}; }}
QPushButton[kind="danger"]:disabled {{ color: {rgba(t.red, .4)}; border-color: {rgba(t.line)}; background: transparent; }}
QPushButton[kind="ghost"], QToolButton[kind="ghost"] {{ background: transparent; border: 1px solid transparent; color: {t.muted}; padding: 5px 8px; }}
QPushButton[kind="ghost"]:hover, QToolButton[kind="ghost"]:hover {{ color: {t.fg}; background: {rgba(t.bg3)}; }}
QPushButton[kind="seg"] {{ border-radius: 8px; padding: 5px 12px; background: transparent; border: 1px solid transparent; color: {t.muted}; }}
QPushButton[kind="seg"]:checked {{ background: {sel_strong}; color: {t.fg}; border-color: {rgba(t.accent, .45)}; }}
QLineEdit, QSpinBox, QComboBox, QPlainTextEdit, QTextEdit, QTextBrowser {{
    background: {rgba(t.field_bg)}; border: 1px solid {rgba(t.line if t.dark else (0, 0, 0, .10))}; border-radius: 8px;
    padding: 6px 9px; selection-background-color: {rgba(t.accent, .45)}; selection-color: {t.fg}; }}
QPlainTextEdit, QTextEdit, QTextBrowser {{ padding: 8px 10px; }}
QLineEdit:focus, QSpinBox:focus, QComboBox:focus, QPlainTextEdit:focus, QTextEdit:focus {{ border-color: {t.accent}; }}
QLineEdit:disabled, QSpinBox:disabled {{ color: {t.muted}; }}
QPlainTextEdit#log, QPlainTextEdit#code, QTextBrowser#diff {{ background: {rgba(t.code)}; border: 1px solid {rgba(t.line)}; }}
QSpinBox::up-button, QSpinBox::down-button {{ width: 0px; border: none; }}
QComboBox::drop-down {{ border: none; width: 22px; }}
QComboBox::down-arrow {{ width: 9px; height: 9px; margin-right: 8px; }}
QAbstractScrollArea::corner {{ background: transparent; border: none; }}
QComboBox QAbstractItemView {{ background: {rgba(t.glass_strong, 1)}; border: 1px solid {rgba(t.rim)}; border-radius: 8px; padding: 4px; selection-background-color: {sel_strong}; selection-color: {t.fg}; }}
QCheckBox {{ spacing: 8px; background: transparent; }}
QCheckBox::indicator {{ width: 16px; height: 16px; border-radius: 5px; border: 1px solid {rgba(t.muted, .6)}; background: {rgba(t.field_bg)}; }}
QCheckBox::indicator:checked {{ background: {t.accent}; border-color: {t.accent}; image: none; }}
QRadioButton {{ spacing: 8px; background: transparent; }}
QTableWidget, QTreeWidget, QListWidget, QTreeView, QTableView, QListView {{
    background: transparent; border: none; gridline-color: transparent; selection-background-color: {sel_strong}; selection-color: {t.fg}; }}
QTableWidget::item, QTreeWidget::item, QTreeView::item, QTableView::item {{ padding: 6px 6px; border-bottom: 1px solid {rgba(t.line)}; }}
QTableWidget::item:hover, QTreeWidget::item:hover, QTreeView::item:hover, QListWidget::item:hover {{ background: {rgba(t.bg3)}; }}
QTableWidget::item:selected, QTreeWidget::item:selected, QTreeView::item:selected, QListWidget::item:selected, QTableView::item:selected {{ background: {sel}; color: {t.fg}; }}
QListWidget::item {{ border-radius: 10px; margin: 2px 0px; }}
QHeaderView {{ background: transparent; }}
QHeaderView::section {{ background: transparent; color: {t.muted}; border: none; border-bottom: 1px solid {rgba(t.line)}; padding: 6px 6px; font-size: 11.5px; font-weight: 600; }}
QTableCornerButton::section {{ background: transparent; border: none; }}
QScrollArea, QScrollArea > QWidget > QWidget, QStackedWidget {{ background: transparent; border: none; }}
QScrollBar:vertical {{ background: transparent; width: 10px; margin: 2px; }}
QScrollBar:horizontal {{ background: transparent; height: 10px; margin: 2px; }}
QScrollBar::handle {{ background: {rgba(t.muted, .28)}; border-radius: 3px; min-height: 24px; min-width: 24px; }}
QScrollBar::handle:hover {{ background: {rgba(t.muted, .5)}; }}
QScrollBar::add-line, QScrollBar::sub-line, QScrollBar::add-page, QScrollBar::sub-page {{ background: none; border: none; width: 0; height: 0; }}
QTabWidget::pane {{ border: none; background: transparent; top: -1px; }}
QTabBar {{ background: transparent; qproperty-drawBase: 0; }}
QTabBar::tab {{ background: transparent; color: {t.muted}; border: 1px solid transparent; border-radius: 8px; padding: 6px 14px; margin-right: 4px; }}
QTabBar::tab:hover {{ color: {t.fg}; background: {rgba(t.bg3)}; }}
QTabBar::tab:selected {{ color: {t.fg}; background: {sel}; border-color: {rgba(t.accent, .35)}; }}
QTabBar::close-button {{ subcontrol-position: right; }}
QProgressBar {{ background: {rgba(t.bg3)}; border: none; border-radius: 4px; max-height: 8px; min-height: 8px; text-align: center; color: transparent; }}
QProgressBar::chunk {{ border-radius: 4px; background: qlineargradient(x1:0, y1:0, x2:1, y2:0, stop:0 {t.accent}, stop:1 {t.accent2}); }}
QMenu {{ background: {rgba(t.glass_strong, 1)}; border: 1px solid {rgba(t.rim)}; border-radius: 10px; padding: 5px; }}
QMenu::item {{ padding: 6px 18px; border-radius: 6px; }}
QMenu::item:selected {{ background: {sel_strong}; }}
QSplitter::handle {{ background: transparent; }}
QSplitter::handle:horizontal {{ width: 12px; }}
QSplitter::handle:vertical {{ height: 12px; }}
QMessageBox QLabel {{ min-width: 320px; }}
"""
