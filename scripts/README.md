# 维护脚本

这里只保留当前启动、构建和验证所需的入口。

| 文件 | 用途 |
| --- | --- |
| `start-client-admin.ps1` | 两个根目录 CMD 入口共用的管理员启动逻辑 |
| `install-desktop-deps.ps1` | 源码运行时安装桌面执行器与 OCR 依赖 |
| `package-exe.ps1` | 构建当前单进程 EXE 便携目录与 ZIP，可调用签名 |
| `sign-exe.ps1` | Authenticode 签名与时间戳 |
| `moments-client.spec` | PyInstaller 资源与依赖收集配置 |
| `exe-entry.py` | 冻结程序入口及隔离的包内自检 |
| `exe-notices.py` | 收集第三方许可证 |
| `exe-requirements.txt` | 构建依赖入口 |
| `exe-requirements-lock.txt` | 可重复构建的依赖版本锁定 |
| `verify.mjs` | Mock Cordis 中检查插件注册、默认门禁、数据库与资源回收 |

运行回归：`npm test`、`npm run test:desktop`、`npm run test:client`。完整 EXE 构建方法见 [发布说明](../docs/EXE-RELEASE.md)。`.tmp/exe-build-env` 为保留的构建环境，其余 `.tmp` 内容均为可重新生成的临时产物。

一次性截图、演示、手动数据库初始化和旧源码便携包打包脚本已删除；数据库在插件启动时自动迁移。正式测试及测试图片生成工具保留，以便验证功能和重建测试素材。
