# 核查：桌面执行器无法启用的原因，以及它是否在客户端里

> 时间：2026-10-23 21:00（Asia/Shanghai）
> 结论：**修复前不在客户端包里**。桌面执行器是独立的管理员进程，不是浏览器/客户端服务内部模块；
> 1.1.0 旧包缺少 `desktop/`，管理员启动器指向的文件不存在，因此无法启动。
> 现已把执行器源码打进客户端包，并在本机启用插件配置、启动 geometry 执行器（非管理员，降级运行）。

## 1. 修复前实际状态（核查证据）

### 1.1 客户端包不含执行器

```text
release\DSH-Moments-Client-1.1.0-win64\
├─ Start-Moments-Client.cmd
├─ Start-Moments-Client-Admin.cmd
├─ client\server.py
├─ client\web\...
└─ scripts\start-client-admin.ps1
```

没有 `desktop/`。而 `scripts/start-client-admin.ps1` 中启动的是：

```text
desktop/server.py
```

因此从 zip 运行 `Start-Moments-Client-Admin.cmd` 会立刻失败：
“当前目录缺少 desktop\\server.py”。

### 1.2 插件配置没有启用执行器

`C:\Users\10575\.dsh\profiles\desktop\cordis.patch.yml`：

```yaml
desktopExecutor:
  enabled: false
  baseUrl: http://127.0.0.1:18765
```

插件 health 返回：

```json
"desktopExecutor": {
  "status": "unavailable",
  "message": "桌面执行器未启用"
}
```

即使手工启动执行器，插件也不会去连接它。

### 1.3 执行器进程/令牌不存在

- `127.0.0.1:18765` 未监听；
- `data/desktop-token.txt` 不存在；
- 因此客户端/插件都显示“桌面执行器不可用/未启用”。

## 2. 修复内容

1. **把执行器源码打进客户端包**：
   - `desktop/*.py`、`desktop/ocr/win_helper.py`、README、requirements；
   - `scripts/install-desktop-deps.ps1`（按需安装 RapidOCR/winsdk 到 `desktop/.vendor`）；
   - `Start-Moments-Client-Admin.cmd` 现在可以在完整包内找到 `desktop/server.py`。
2. **启用插件配置**（本机）：
   - `desktopExecutor.enabled: true`
   - `tokenFile: D:/dsh插插/dsh-moments-agent/data/desktop-token.txt`
   - 备份：`cordis.patch.yml.bak-executor-*`
3. **启动 geometry 执行器**（当前非管理员）：
   - `driver=geometry, mode=PREPARE_ONLY, ocrAvailable=true, adminPrivilege=false`
   - 插件 health 变为 `degraded`：<br>
     “geometry 驱动已启用，但当前非管理员权限，输入操作会返回 PRIVILEGE_REQUIRED”
   - 客户端 `/proxy/api/health` 也能看到该降级状态。
4. **管理员启动器**：
   - 检测已有执行器是否管理员；
   - 若是非管理员实例，会停止并以管理员重启；
   - UAC 提权后 `adminPrivilege=true`，才具备底层鼠标输入权限。

## 3. “是否写入客户端中”的准确回答

- **代码/打包层面**：是。1.1.0 新包已包含 `desktop/` 执行器源码，启动器在同包内可找到。
- **运行架构层面**：不是嵌入在浏览器或客户端 HTTP 服务里的模块。执行器必须作为**独立的管理员进程**运行，原因：
  - 微信 4.x 运行在更高完整性级别，普通权限鼠标输入会被拒绝；
  - 浏览器/客户端服务不应持有管理员输入权限；
  - 执行器需要独立 token、独立生命周期、独立审计。
- 因此正确说法是：**客户端包携带执行器，并由管理员启动器拉起，而不是“写进客户端服务进程”**。

## 4. 当前验证结果

| 检查项 | 结果 |
| --- | --- |
| 客户端包包含 desktop 源码 | ✅ |
| 包内执行器可独立启动（非管理员） | ✅ `/health ok=true, driver=geometry, wechatInstalled=true, ocrAvailable=false（未装 vendor）` |
| 插件 desktopExecutor 配置 | ✅ enabled=true，health=degraded（非管理员） |
| 客户端代理显示执行器状态 | ✅ degraded + PRIVILEGE_REQUIRED 原因 |
| 管理员启动器语法/路径 | ✅ |
| 真实 UAC 提权 | ❌ NOT_TESTED（本会话无法完成 UAC 交互） |
| 真实管理员 geometry 输入 | ❌ NOT_TESTED |
| 客户端包 OCR 依赖 | ⚠️ 不内置 300MB vendor；需 `scripts\install-desktop-deps.ps1` |

## 5. 现在如何真正启用

1. 双击 `Start-Moments-Client-Admin.cmd`，接受 UAC；
   启动器会检测并替换当前非管理员执行器；
2. 如需 OCR，先运行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-desktop-deps.ps1
```

3. 打开客户端「首次配置」第 E/F 步，检查：
   - executor `/health`：`driver=geometry, adminPrivilege=true, ocrAvailable=true`
   - 插件 health 的 `desktopExecutor.status` 不再是 unavailable；
4. 先 PREPARE_ONLY 演练，确认无误后再 `-AllowPublish` 做真实发布/删除。

## 6. 相关文件

- 启动器：`Start-Moments-Client-Admin.cmd`、`scripts/start-client-admin.ps1`
- 依赖安装：`scripts/install-desktop-deps.ps1`
- 执行器：`desktop/server.py`、`desktop/geometry_driver.py`、`desktop/ocr/win_helper.py`
- 打包脚本：`scripts/package-client.ps1`
- 验证记录：`docs/audit/VERIFICATION_ROUND5.md`
