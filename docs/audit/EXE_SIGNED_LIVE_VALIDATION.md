# EXE 签名与管理员实机复测

2026-10-24（Asia/Singapore）。本记录更新此前尚未通过 UAC 的验收状态。

- 核对原客户端和独立执行器的命令行、解释器路径及项目截图目录后，关闭旧客户端并停止旧执行器。重新查询确认旧项目进程消失。PID 可能被其他软件复用，后续检查按进程身份判断，未终止无关程序。
- 未签名 EXE 完成真实 UAC 启动，客户端和执行器端口 18770 / 18765 同属 PID 29888，`adminPrivilege=true`、`ocrAvailable=true`、页面 HTTP 200。
- 通过客户端退出接口停止应用，确认两个监听端口均释放，然后签名。
- 用户明确选择本地自签名。生成当前用户代码签名证书：主体 `CN=DSH Moments Agent Local Build`，指纹 `D54E26CAE38C7C302FE583A7C3360A93C5C1EA5B`。RSA 3072、SHA256、私钥不可导出，保留在当前用户 My 证书库中。未修改信任根或受信任发布者库。
- EXE 已写入 Authenticode SHA256 签名与 DigiCert 时间戳。独立提取 PE 的 PKCS7，`SignedCms.CheckSignature(true)` 通过，重新计算 PE Authenticode SHA256 与签名内容中的摘要相符。
- Windows Authenticode 检查返回证书链终止于不受信任的根（状态 `UnknownError`），与本次未加入信任库的自签名证书一致。此状态不等于已获得 Windows 发布者信任。
- 签名后的 EXE 再次通过 UAC 启动。端口 18770 / 18765 同属 PID 6912，`adminPrivilege=true`、`ocrAvailable=true`，HTML/JS/CSS 均 HTTP 200，保持 PREPARE_ONLY。
- 已重新生成 ZIP，确认 ZIP 内 EXE 与签名后文件逐字节一致、ZIP CRC 完整、包含公开证书、不包含私钥或真实令牌，并更新 SHA256SUMS。

签名复用脚本：`scripts/sign-exe.ps1`。重建时指定 `scripts/package-exe.ps1 -SigningThumbprint <上述指纹>`。当前运行状态和交付证据见 `release/DSH-Moments-Client-1.1.2-verification.json`。本轮未执行微信 prepare/publish/delete。
