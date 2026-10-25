"""Resolution-independent OCR targets in current screenshot coordinates. No input."""
from __future__ import annotations

from .ocr import normalize_ocr_text
from .wechat4_geometry import _is_publish_green

LABELS = {"discover": ("发现", "Discover"), "moments_entry": ("朋友圈", "Moments"),
    "publish": ("发表", "发布", "Publish"), "cancel": ("取消", "Cancel"),
    "paste": ("粘贴", "Paste"), "camera": ("相机", "拍照", "Camera"),
    "editor_text": ("这一刻的想法", "这一刻的想法...", "这一刻的想法…", "说点什么", "Share your thoughts")}


def locate_controls(result, width, height, rows=None):
    if not result.available or width <= 0 or height <= 0:
        return {}
    if rows is not None and (len(rows) != height or any(len(row) != width * 3 for row in rows)):
        raise ValueError("Invalid RGB dimensions")
    found = {}
    for name, labels in LABELS.items():
        candidates = []
        accepted = {normalize_ocr_text(label).casefold() for label in labels}
        for item in [*result.words, *result.lines]:
            if normalize_ocr_text(item.text).casefold() not in accepted:
                continue
            box = item.bbox
            x, y = box.center
            if box.width <= 0 or box.height <= 0 or box.x < 0 or box.y < 0 or box.x + box.width > width or box.y + box.height > height:
                continue
            if box.width > width * .4 or box.height > height * .15:
                continue
            if name == "discover" and x > width * .2:
                continue
            if name == "moments_entry" and (x > width * .5 or y > height * .6):
                continue
            if name == "camera" and (x < width * .65 or y > height * .3):
                continue
            if name == "publish":
                if x < width * .2 or rows is None:
                    continue
                pad = max(4, box.height // 2)
                green = count = 0
                for yy in range(max(0, box.y - pad), min(height, box.y + box.height + pad), 2):
                    for xx in range(max(0, box.x - pad), min(width, box.x + box.width + pad), 2):
                        count += 1
                        green += _is_publish_green(tuple(rows[yy][xx * 3:xx * 3 + 3]))
                if count == 0 or green / count < .25:
                    continue
            # OCR often reports the same text as both a word and a line.
            if any(abs(x - old.bbox.center[0]) < max(4, min(box.height, old.bbox.height)) and
                   abs(y - old.bbox.center[1]) < max(4, min(box.height, old.bbox.height)) for old in candidates):
                continue
            candidates.append(item)
        if len(candidates) == 1:
            box = candidates[0].bbox
            found[name] = {"x": box.center[0], "y": box.center[1], "bbox": box.to_dict(),
                "method": "ocr+green" if name == "publish" else "ocr-exact", "clickable": True}
    return found
