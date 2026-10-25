# 客户端测试

```powershell
cd D:\dsh插插\dsh-moments-agent
D:\dsh\resources\runtime\primary-runtime\dependencies\python\python.exe -m unittest discover -s client/tests -v
```

- `test_api_client.py`：API 客户端与错误映射（使用 `fake_admin_server.py` 的 127.0.0.1 随机端口假服务）；
- `test_config.py`：配置读写与“令牌绝不落盘”约束；
- `test_discovery.py`：本机路径/服务探测与受限 YAML 读取；
- `test_auto_configure.py`：自动配置核心（profile 选择、配置块渲染/合并、备份与原子写、幂等、Reader 探测注入、脱敏、CLI）；
- `test_web_server.py`：本地 Web 服务（自动配置端点、鉴权、静态文件与代理）；
- 全部测试不访问外网、不依赖真实插件、不使用真实令牌（假服务令牌运行时随机生成），也不读写真实 `~/.dsh` profile。

## 关于 `.tmp/` 与少量空目录

早期一次测试使用 `tempfile.TemporaryDirectory`（内部以 `mode=0o700` 创建目录）。
在 DSH 自带 Python 3.12 + Windows 沙箱下，这类目录会被 ACL 限制，连创建者也无法写入/删除，
因此本目录可能残留若干**空目录**（`.tmp/moments-client-*`、`probe700b`、`probe700d`、
`tmp__drix_4`、`tmps0iqfheq`）。

- 这些目录不含源码、凭据或测试数据，也不影响测试运行；
- 后续测试已改用默认权限的 `os.makedirs`（见 `__init__.py` 的 `WorkspaceTempDir`）；
- 需清理时请在 Host 侧使用完全权限删除本目录下的 `.tmp/` 与上述空目录。
