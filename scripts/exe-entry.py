"""Frozen desktop entry and read-only packaging diagnostics."""
import json
import sys
import tempfile
import urllib.request
from pathlib import Path

from client import server


def self_test(destination):
    from desktop.config import ExecutorConfig
    from desktop.ocr import WindowsOcrProvider
    from desktop.wechat_driver import FakeWechatDriver
    from PIL import Image, ImageDraw, ImageFont

    report = {"version": server.VERSION, "pid": __import__("os").getpid(),
              "adminPrivilege": server.is_admin(), "executable": sys.executable}
    try:
        report["webAssets"] = all((server.WEB_ROOT / name).is_file() for name in ("index.html", "app.js", "styles.css"))
        with tempfile.TemporaryDirectory(prefix="moments-exe-check-") as folder:
            root = Path(folder)
            config = ExecutorConfig(port=0, token_file=str(root / "token.txt"),
                                    screenshot_dir=str(root / "screenshots"), log_file=str(root / "executor.log"))
            embedded = server.EmbeddedExecutor(config, driver=FakeWechatDriver())
            try:
                request = urllib.request.Request(f"http://127.0.0.1:{embedded.server.server_port}/health",
                    headers={"X-Moments-Token": (root / "token.txt").read_text().strip()})
                with urllib.request.urlopen(request, timeout=10) as response:
                    report["executorHttp"] = json.load(response)["ok"]
            finally:
                embedded.close()
            report["executorStopped"] = not embedded.thread.is_alive()
            image = Image.new("RGB", (600, 140), "white")
            font = ImageFont.truetype("arial.ttf", 64)
            ImageDraw.Draw(image).text((25, 25), "DSH 2026", fill="black", font=font)
            image.save(root / "ocr.png")
            ocr = WindowsOcrProvider(ocr_python=sys.executable, timeout=40)
            report["ocrAvailable"] = ocr.available
            result = ocr.recognize(str(root / "ocr.png"))
            report["ocrText"] = result.text
            report["ocrRecognized"] = result.available and "DSH" in result.text and "2026" in result.text
        report["ok"] = all(report[k] for k in ("webAssets", "executorHttp", "executorStopped", "ocrAvailable", "ocrRecognized"))
    except Exception as exc:
        report.update(ok=False, error=f"{type(exc).__name__}: {exc}")
    Path(destination).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--self-test-report":
        raise SystemExit(self_test(sys.argv[2]))
    result = server.main()
    if result and server.FROZEN:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, "启动失败，请查看 data/client-web.log；如端口被占用，请先退出旧版本。", "DSH Moments Agent", 16)
    raise SystemExit(result)
