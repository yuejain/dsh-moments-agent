"""WeChat 4.x（Qt 5.15）朋友圈几何测绘与像素检测。

背景
----
微信 4.1.10.27 使用 Qt51514QWindowIcon，UIA 树只暴露 TitleBar（第二轮已验证），
无法通过控件名/自动化 ID 定位。这里把「窗口内的相对几何 + 颜色检测」固化成
可测试的测绘层，供实验性桌面驱动使用；不包含任何点击/输入副作用。

坐标约定
--------
- 所有 `Point` 都是**窗口截图内坐标**（左上角为 0,0，含标题栏）。
- `to_screen(window_origin)` 把窗口内坐标转换为屏幕物理坐标。
- 已知窗口尺寸下提供经验值；正式点击前应优先调用 `detect_publish_button()`
  对当前截图做绿色按钮检测，避免 DPI/窗口尺寸变化导致误点。

安全边界
--------
本模块只做测量/检测，不执行点击、不读写剪贴板、不连接微信进程。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

# 已知窗口尺寸 -> 朋友圈关键点（窗口内坐标，含标题栏）
# 数据来自 2026-10-20/23 真实微信 4.1.10.27 窗口截图。
KNOWN_PROFILES: dict[tuple[int, int], dict[str, tuple[int, int]]] = {
    (1200, 900): {
        "camera": (1144, 85),
        "discover": (58, 361),
        "moments_entry": (180, 152),
        "editor_text": (500, 220),
        "publish": (510, 675),
        "cancel": (690, 675),
        "first_post_trash": (682, 733),
        "post_actions": (1124, 733),
    },
    (1342, 971): {
        # 第二轮 1342x971 窗口；publish 实际点击点 (579,761)（窗口内）
        "camera": (1289, 85),
        "discover": (65, 389),
        "moments_entry": (202, 151),
        "editor_text": (558, 238),
        "publish": (579, 761),
        "cancel": (759, 761),
        "first_post_trash": (762, 790),
        "post_actions": (1256, 790),
    },
}


@dataclass(frozen=True)
class WindowRect:
    left: int
    top: int
    width: int
    height: int

    @property
    def origin(self) -> tuple[int, int]:
        return self.left, self.top


@dataclass(frozen=True)
class Point:
    x: int
    y: int

    def scaled(self, factor_x: float, factor_y: float) -> "Point":
        return Point(round(self.x * factor_x), round(self.y * factor_y))


class WeChat4Geometry:
    """一个微信主窗口的几何测绘结果。

    对未知尺寸，用最接近的已知 profile 做比例缩放；这只是 fallback，
    发布按钮请务必用 `detect_publish_button` 做像素复核。
    """

    def __init__(self, window: WindowRect, profile: tuple[int, int] | None = None):
        self.window = window
        if profile is None:
            profile = min(
                KNOWN_PROFILES,
                key=lambda size: abs(size[0] - window.width) + abs(size[1] - window.height),
            )
        self.profile = profile
        self._base = KNOWN_PROFILES[profile]
        self._scale_x = window.width / profile[0]
        self._scale_y = window.height / profile[1]

    def point(self, name: str) -> Point:
        if name not in self._base:
            raise KeyError(name)
        base = self._base[name]
        return Point(round(base[0] * self._scale_x), round(base[1] * self._scale_y))

    def to_screen(self, point: Point) -> Point:
        return Point(self.window.left + point.x, self.window.top + point.y)

    def screen_point(self, name: str) -> Point:
        return self.to_screen(self.point(name))

    def camera_point(self) -> Point:
        return self.point("camera")

    def editor_text_point(self) -> Point:
        return self.point("editor_text")

    def publish_point(self) -> Point:
        return self.point("publish")

    def cancel_point(self) -> Point:
        return self.point("cancel")

    def as_dict(self) -> dict:
        return {
            "window": {
                "left": self.window.left,
                "top": self.window.top,
                "width": self.window.width,
                "height": self.window.height,
            },
            "profile": list(self.profile),
            "scale": [round(self._scale_x, 4), round(self._scale_y, 4)],
            "points": {
                name: {"x": self.point(name).x, "y": self.point(name).y}
                for name in self._base
            },
        }


# ---------------------------------------------------------------------------
# 像素检测
# ---------------------------------------------------------------------------

def _is_publish_green(rgb: tuple[int, int, int]) -> bool:
    r, g, b = rgb
    return r < 110 and g > 120 and b > 40 and g > r + 45 and g > b + 15


def _components(points: Iterable[tuple[int, int]], gap: int = 2) -> list[dict]:
    """把点集按行/列邻近聚成连通块（O(n) 的简化投影聚类，足够处理按钮矩形）。"""
    pts = sorted(set(points))
    if not pts:
        return []
    # 先按 y 分带，再按 x 连续性切分
    bands: list[list[tuple[int, int]]] = []
    for p in sorted(pts, key=lambda item: item[1]):
        if not bands or p[1] - bands[-1][-1][1] > gap:
            bands.append([p])
        else:
            bands[-1].append(p)
    components: list[dict] = []
    for band in bands:
        band_sorted = sorted(band, key=lambda item: item[0])
        groups: list[list[tuple[int, int]]] = []
        for p in band_sorted:
            if not groups or p[0] - groups[-1][-1][0] > gap:
                groups.append([p])
            else:
                groups[-1].append(p)
        for group in groups:
            xs = [p[0] for p in group]
            ys = [p[1] for p in group]
            components.append(
                {
                    "left": min(xs),
                    "top": min(ys),
                    "right": max(xs),
                    "bottom": max(ys),
                    "width": max(xs) - min(xs) + 1,
                    "height": max(ys) - min(ys) + 1,
                    "area": len(group),
                }
            )
    # 合并同一按钮在相邻行带中被切开的块
    merged: list[dict] = []
    for comp in components:
        for target in merged:
            if (
                comp["left"] <= target["right"] + 4
                and comp["right"] >= target["left"] - 4
                and comp["top"] <= target["bottom"] + 4
                and comp["bottom"] >= target["top"] - 4
            ):
                target["left"] = min(target["left"], comp["left"])
                target["top"] = min(target["top"], comp["top"])
                target["right"] = max(target["right"], comp["right"])
                target["bottom"] = max(target["bottom"], comp["bottom"])
                target["width"] = target["right"] - target["left"] + 1
                target["height"] = target["bottom"] - target["top"] + 1
                target["area"] += comp["area"]
                break
        else:
            merged.append(dict(comp))
    return merged


def _detect_publish_button_from_pixels(
    get_pixel,
    width: int,
    height: int,
    *,
    min_width: int = 90,
    min_height: int = 24,
) -> Point | None:
    """在像素访问器上执行绿色按钮检测（供 PIL 与纯 RGB 两条路径复用）。"""
    if width <= 0 or height <= 0:
        return None
    # 只在右侧区域找，避开发送侧边栏里同样为绿色的「朋友圈」选中项
    x_start = int(width * 0.25)
    y_start = int(height * 0.35)
    points: list[tuple[int, int]] = []
    step = 2  # 2x2 采样，兼顾速度与边界
    for y in range(y_start, height, step):
        for x in range(x_start, width, step):
            if _is_publish_green(get_pixel(x, y)):
                points.append((x, y))
    candidates = []
    for comp in _components(points):
        if comp["width"] < min_width or comp["height"] < min_height:
            continue
        # 按钮的宽高比大约 3.2~4.2；排除大块绿色背景
        ratio = comp["width"] / max(1, comp["height"])
        if not (2.2 <= ratio <= 5.5):
            continue
        candidates.append(comp)
    if len(candidates) != 1:
        return None
    best = candidates[0]
    return Point((best["left"] + best["right"]) // 2, (best["top"] + best["bottom"]) // 2)


def detect_publish_button(image, *, min_width: int = 90, min_height: int = 24) -> Point | None:
    """在 PIL 截图里找绿色「发表」按钮，返回按钮中心点（窗口内坐标）。

    image: PIL.Image.Image（RGB 或可转换）
    找不到时返回 None，调用方必须视为「不能点击」而不是猜坐标。
    """
    rgb = image.convert("RGB")
    width, height = rgb.size
    pixels = rgb.load()
    return _detect_publish_button_from_pixels(
        lambda x, y: pixels[x, y],
        width,
        height,
        min_width=min_width,
        min_height=min_height,
    )


def detect_publish_button_rgb(
    width: int,
    height: int,
    rows,
    *,
    min_width: int = 90,
    min_height: int = 24,
) -> Point | None:
    """纯标准库版本：在 ``(width, height, rgb_rows)`` 上检测绿色「发表」按钮。

    ``rgb_rows`` 每行必须是 ``width * 3`` 字节的 RGB 数据（自上而下），
    与 ``WindowLocator.capture_window_rgb()`` 的返回格式一致。
    检测失败返回 None；调用方禁止在 None 时点击。
    """
    rows = list(rows)
    if len(rows) != height:
        raise ValueError("RGB 行数与 height 不匹配")
    if width <= 0 or height <= 0:
        return None
    for index, row in enumerate(rows):
        if len(row) < width * 3:
            raise ValueError(f"RGB 第 {index} 行长度不足（需要 {width * 3} 字节）")

    def _get_pixel(x: int, y: int) -> tuple[int, int, int]:
        row = rows[y]
        offset = x * 3
        return row[offset], row[offset + 1], row[offset + 2]

    return _detect_publish_button_from_pixels(
        _get_pixel,
        width,
        height,
        min_width=min_width,
        min_height=min_height,
    )


def detect_editor_modal(image) -> dict | None:
    """粗略检测纯文字编辑器白色弹层（用于调试/日志，不参与点击决策）。"""
    rgb = image.convert("RGB")
    width, height = rgb.size
    pixels = rgb.load()
    # 编辑器弹层是接近纯白的大块；背景朋友圈是深灰/白色混合，只在中间区域找。
    xs: list[int] = []
    ys: list[int] = []
    for y in range(int(height * 0.10), int(height * 0.85), 4):
        for x in range(int(width * 0.15), int(width * 0.90), 4):
            r, g, b = pixels[x, y]
            if r > 245 and g > 245 and b > 245:
                xs.append(x)
                ys.append(y)
    if len(xs) < 500:
        return None
    return {
        "left": min(xs),
        "top": min(ys),
        "right": max(xs),
        "bottom": max(ys),
        "coverage": len(xs) / max(1, (width * height) / 16),
    }
