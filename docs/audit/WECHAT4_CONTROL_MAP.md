# WeChat 4.x 控件测绘（朋友圈纯文字发布）

> 环境：微信 `4.1.10.27`（WeChatAgent 固定客户端），Qt `51514QWindowIcon`，Windows 10/11 x64，150% DPI
> 结论：微信 4.x 的 Qt 窗口**不提供可用的 UIA 控件树**，朋友圈发布采用「窗口几何 + 像素检测 + 鼠标长按/右键菜单」；
> 已在真实账号完成一次纯文字发布（见 [VERIFICATION_ROUND4.md](VERIFICATION_ROUND4.md)）。

## 1. 为什么不是控件树

第二轮已实测：即使管理员权限，`Inspect.exe`/pywinauto UIA 对微信主窗口只能看到 `TitleBar`，
`descendantCount = 1`。微信 4.x 没有开放 Qt Accessibility，因此无法按控件名/ AutomationId 定位。
本测绘把 UIA 不可用这一事实固定下来，改用**窗口内相对坐标 + 颜色检测 + 交互结果验证**。

## 2. 窗口与关键区域

主窗口截图（1200×900，含标题栏）：

| 区域 | 1200×900 坐标（窗口内） | 1342×971 坐标 | 用途 |
| --- | --- | --- | --- |
| 相机图标 | `(1144, 85)` | `(1289, 85)` | 单击=图片/视频；**长按 1s=纯文字编辑器** |
| 发现侧栏 | `(58, 361)` | `(65, 389)` | 打开「发现」 |
| 朋友圈入口 | `(180, 152)` | `(202, 151)` | 进入朋友圈 |
| 编辑器文本区 | `(500, 220)` | `(558, 238)` | 右键 → 粘贴 |
| 发表按钮中心 | `(510, 675)` | `(579, 761)` | 绿色按钮，点击发布 |
| 取消按钮 | `(690, 675)` | `(759, 761)` | 关闭编辑器 |
| 首条动态删除 | `(682, 733)` | `(762, 790)` | 自己动态的垃圾桶（需要 hover） |
| 动态操作 `...` | `(1124, 733)` | `(1256, 790)` | 赞/评论菜单 |

关键截图：

- 纯文字编辑器（空）（本机验收存档）
- 已粘贴待发表（本机验收存档）
- 发布成功后的朋友圈（本机验收存档）
- FengWo 规则模式（修复网络的关键）（本机验收存档）

## 3. 纯文字发布流程（实测有效）

1. 窗口恢复并置顶；确认标题/尺寸；
2. **长按**相机图标 `camera` ≥ 900 ms —— 单击会打开文件选择器（图文模式），长按才进入纯文字编辑器；
3. 在文本区右键 → 点击「粘贴」（键盘 Ctrl+V 被微信 4.x 拦截，鼠标菜单可用）；
4. 校验文本已出现（截图/像素比对；正式流程应以审批内容哈希绑定）；
5. 用绿色按钮检测定位「发表」并单击；
6. 观察结果：成功时编辑器关闭、朋友圈出现自己的动态；失败时出现红色「文字未发送」toast，需要重试/排查网络；
7. 发布后从朋友圈读取时间与内容做人工核对（无 OCR，无法自动读文字）。

> 发布前必须由审批系统确认账号、正文哈希、素材清单、可见范围；该流程只是“执行层”，不替代审批。

## 4. 像素检测（可测试实现）

代码：[desktop/wechat4_geometry.py](../../desktop/wechat4_geometry.py)
测试：[desktop/tests/test_wechat4_geometry.py](../../desktop/tests/test_wechat4_geometry.py)（9 项通过）

```python
from desktop.wechat4_geometry import WindowRect, WeChat4Geometry, detect_publish_button

geo = WeChat4Geometry(WindowRect(left=40, top=40, width=1200, height=900))
geo.screen_point("camera")        # -> Point(1184, 125)
geo.screen_point("editor_text")   # -> Point(540, 260)

# 当前编辑器截图（PIL.Image）中检测绿色「发表」按钮
point = detect_publish_button(screenshot)
if point is None:
    raise RuntimeError("发表按钮未检测到，禁止盲点")
geo.to_screen(point)              # -> 屏幕物理坐标
```

检测策略：

- RGB 过滤：`g > 120`、`g > r + 45`、`g > b + 15`、`r < 110`；
- 只在右侧 `x > 25%`、`y > 35%` 区域采样，避开侧栏绿色选中项；
- 连通块宽高比 2.2–5.5、宽 ≥90、高 ≥24，取面积最大者；
- 返回 `None` 时**禁止点击**，不做坐标猜测。

## 5. 网络/代理前提（比控件更关键）

本轮定位到“文字未发送”的主因是**代理全局模式**：

- FengWo（FlClash 内核）默认 `mode: global`，微信流量全部走新加坡节点；
- 微信的 MMTLS/朋友圈长连接经代理容易被拦截或超时；
- 切到 **规则模式**（`mode: rule`）后，已有规则：
  - `DOMAIN-SUFFIX,qq.com,DIRECT`
  - `DOMAIN-SUFFIX,tencent.com,DIRECT`
  - `DOMAIN-SUFFIX,gtimg.com,DIRECT`
  让微信域名直连；实测发布立即成功，toast 消失。
- 建议额外补充（如需）：`weixinbridge.com`、`qpic.cn`、`servicewechat.com`、`WeChatAppEx.exe` 的 DIRECT 规则。

## 6. 限制与安全边界

- 几何坐标对 DPI/窗口尺寸敏感，必须用 `detect_publish_button` 复核绿色按钮，不能盲点；
- 文字读取已接入 Windows OCR（PDF/截图核验），但真实微信窗口的 OCR 稳定性仍需人工验收；
- 键盘注入被微信拦截，文本输入必须走剪贴板 + 鼠标右键菜单；
- 已接入正式执行器：`--driver geometry`（opt-in），发布/删除还需 `--allow-publish + --geometry-allow-publish + mode=APPROVAL_REQUIRED`；默认仍 `PREPARE_ONLY`；
- 真实几何 prepare/publish/delete 仍标 NOT_TESTED，详见 [VERIFICATION_ROUND5.md](VERIFICATION_ROUND5.md)；
- 禁止把本流程用于无人值守自动发帖；每次真实发布必须有所有者授权和一次性审批。

## 6.1 正式执行器入口

```powershell
python desktop/server.py --port 18765 --token-file data/desktop-token.txt `
  --driver geometry --mode APPROVAL_REQUIRED `
  --allow-publish --geometry-allow-publish `
  --trusted-account-source wechatagent `
  --expected-account wxid_... `
  --assume-client-version 4.1.10.27 `
  --max-publish-click-retries 1 --retry-backoff-seconds 2
```

- `/health` 暴露 `driver/ocrAvailable/adminPrivilege/maxRetries`；
- `/moments/publish` 有 OCR 核验与有限重试；
- `/moments/delete` 支持删除/回滚（attempt/哈希/正文绑定，OCR 确认消失）。

## 7. 复现清单

- 微信窗口保持 1200×900（或使用已知 profile 的尺寸）；
- 朋友圈处于可滚动、未加载中的状态；
- 代理规则模式且微信域名 DIRECT；
- 剪贴板内容来自已审批草稿；
- 发布后按 [VERIFICATION_ROUND4.md](VERIFICATION_ROUND4.md) 的核对步骤记录结果。

