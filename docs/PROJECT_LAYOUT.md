# 项目目录约定

| 位置 | 内容 |
| --- | --- |
| `src/`、`dist/` | 插件源码与当前可加载的编译输出 |
| `client/`、`desktop/` | 前端、本机服务、桌面执行器及兼容入口 |
| `config/`、`persona/`、`locale/` | 配置示例、人格文件和本地化资源 |
| `data/` | 正式数据库、令牌、素材与运行记录，清理时保护 |
| `tests/`、`client/tests/`、`desktop/tests/`、`fixtures/` | 持续维护的回归测试与合成素材，保留 |
| `scripts/` | 启动、依赖安装、打包、签名及插件自检入口 |
| `.tmp/exe-build-env/` | 可复用的 PyInstaller 构建环境，保留 |
| `.tmp/` 其他内容 | 构建缓存和临时输出，可重新生成 |
| `release/` | 签名 EXE 目录、ZIP、插件包、证书、截图和校验记录；旧版本目录清理尚未执行 |
| `docs/audit/` | 历史审计与验证记录；最新测试日志集中在 `evidence/1.1.4/` |

2026-10-24 已删除五个冗余脚本：`capture-setup.mjs`、`capture-web-client.mjs`、`demo-mock.mjs`、`init-db.mjs`、`package-client.ps1`。保留正式回归测试、运行入口和当前 EXE 打包链路。最新测试日志已集中保存。

旧版本发布包、pip 残留、临时 UI 后台、构建中间文件、重复调试日志和 Python 字节码缓存已列为待清理项。批量删除和缩小到单一构建缓存目录的删除均被自动审批拒绝，返回 `blocked by policy`；未继续重试。因此这些文件目前仍在，不能将计划释放的空间视为已释放。

历史审计文档中的旧包路径、已删除脚本和临时路径是当时的记录。需要复核当前版本时，以 `release/DSH-Moments-Client-1.1.5-verification.json` 与 `docs/audit/CLIPBOARD_SCHEDULE_1_1_5.md` 为准。已执行和未执行明细见 `docs/audit/CLEANUP_2026-10-24.json`。

正式数据、源客户端配置、首次配置进度、当前 EXE 与签名不在清理范围内。已检查四个旧发布目录：其连接配置均为默认值，未发现独立 data 目录或首次配置进度。
