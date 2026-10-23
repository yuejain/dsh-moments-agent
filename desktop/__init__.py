"""DSH Moments Agent —— Windows 桌面执行器包。

对外可直接导入的模块：
- ``desktop.server``：HTTP 服务与 CLI；
- ``desktop.wechat_driver``：``WechatDriver`` / ``RealWechatDriver`` / ``FakeWechatDriver``；
- ``desktop.moments_editor``：prepare / publish 编排；
- ``desktop.moments_verifier``：发布后核验；
- ``desktop.account_guard``：交互桌面/进程/账号/版本校验；
- ``desktop.window_locator``：窗口枚举、安装检测、截图；
- ``desktop.config``：常量、错误码、配置、路径安全、脱敏。
"""

from .config import VERSION

__all__ = ["VERSION"]
