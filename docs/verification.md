# 验收记录

目标宿主：本机 Cindy 0.1.128；源码 tag v0.1.128，commit `9d62b213c960c63daa46996de8a606965f2f2299`。

## 0.2.0 图片与语音文字（2026-11-07）

本次运行通过 check_app_update 核对当前版本 0.1.128，通过 GitHub get_tag 核实正式 tag 指向上述完整 commit；本地 Cindy 仓库提供该 commit 的接口实现。协议参考腾讯官方 openclaw-weixin v2.4.6 / commit `cef0bfc390393f716903e16d50408118047f87e0` 的消息类型、图片发送、CDN 上传及 inbound 语音文字处理。

新增图片单独/混合接收、CDN 下载与 AES-128-ECB 解密、Cindy targets 图片附件转交、伙伴文字/图片回传，以及 voice_item.text 自动作为语音转文字投递。无识别文字时整条拒绝并显示中文处理建议；未另接原始语音 ASR。图片为 PNG/JPEG/WebP、单张 5 MiB、每条最多 4 张。

按固定宿主 nodeRuntimeBroker.ts 的真实限制（params 256 KiB、stdout 单行 1 MiB、timeoutMs ≤ 120000），图片分成 192 KiB base64 块，不在单次 RPC/通知中传完整图片。长回复使用 maxTotalMs 与上传/发送进度通知续期。分块与回传均绑定原请求及连接代次，停用/重绑定/断开释放缓存；共享图片预留上限 40 MiB。

新增测试覆盖语音字段与缺失结果、混合消息、三种密钥编码、CDN 无 Bot Token、域名/重定向/大小/格式拒绝、AES/MD5 与上传线协议、旧 Host 拒绝丢图、跨 Bot 图片额度、下载/上传中断、伙伴身份与图片幂等、分块乱序/缺块/旧代次和清理。编译后的 main.js 在模拟 Host 中处理 5 MiB 图片收发，并强制核对每次请求字节数、通知行长、timeoutMs/maxTotalMs。

首轮本地 npm run build、npm test（53/53）、npm run check 与 Forge 打包、包内 9 项 SHA256 核对均通过。Orca Worker reviewer 独立复跑这些门禁，确认协议与固定宿主契约，要求修复路由在派发失败/取消后未释放 base64 附件，并建议修复图片混合空白文字遭拒绝。Lead 已统一在 finish 清附件、将图片混合空白文字转为图片提示，并补回归、停用/断开时分块清理及缓存回复时暂存清理。修复后 npm run build、npm test（55/55）、npm run check 与重新 Forge pack 均通过。Orca Worker reviewer 再次独立验证全部门禁与包内 9/9 项 SHA256，给出 PASS、无阻塞问题，确认可更新 local 插件并提交。日志在 .logs/build-media.log、.logs/test-media.log、.logs/check-media.log 与 .logs/reviewer-media-fix-*.log。

已知非阻塞限制：CDN 下载/上传 20 秒且只尝试一次；慢网络会安全拒绝，请用户重发。图片先全部上传再发消息，最多 4 张在各阶段均接近时限时可触及总处理预算（Node 210 秒，Host 240 秒）；已经开始发送的超时按 DELIVERY_UNCERTAIN 处理，不重发。真实微信端图片收发、voice_item.text 实际返回、Light/Dark 实机展示仍待验证；模拟和源码核对不作为真实微信成功的证据。

复审另记两个非阻塞边界：畸形 disconnect_bot 调用未提供 id 时可能清空所有待组装图片（正常工具/页面均提供 id）；派发挂起超过 30 分钟且被新消息清理为 expired 后，迟到派发仍可能发送无图提示。均无持久数据损坏，用户可重发；本轮交付保持 reviewer 已核验的实现。

本次 Forge install 实际返回 updated、version 0.2.0、namespace local、instanceId _ns__local__wechat-companion、enabled true，原有配置与数据保持。随后调用该 local 实例的 list_bindings，实际运行版本为 0.2.0，原有 1 组 Bot 为 connected，credentialStorage 为 sealed，recoveryError/capabilityError 均为 null，lastErrorCode 为 null。此为真实安装/运行/登录恢复检查；未借此宣称真实图片或语音端到端已通过。

## 0.1.x 历史验收记录

自动测试覆盖配置一对一约束、两组伙伴独立路由、Host 会话身份校验、同 Bot 单请求派发、重复回传、重绑定失效、委派能力缺失、Node 原始收件人与上下文、发送结果未知、媒体拒绝和 iLink 线协议。

登录持久化测试包括 AES-256-GCM、防篡改/错误密钥、双 Bot 新进程恢复、游标与消息指纹恢复、断开/删除只清本组、Host 保险库自动初始化、private-data 密文读写、工作进程尚未恢复时禁止覆盖保存状态，以及实际编译 main.js 在模拟 Host 中的重启恢复。另有 Node RPC 错误映射、二维码长轮询超时、陈旧扫码状态等回归测试。完整本地日志在 `.logs/`，不纳入公开仓库。

构建、36 项测试、生成代码语法检查已通过。最新交付版本为 0.1.3；用 `scripts/verify-package.ps1` 按 SHA256 核对包内文件与当前构建。测试覆盖成功/失败断开、文件提交后状态同步失败不回滚、同 id 删除重建、断开后新请求、未知发送后继续派发、旧 generation/实例事件、重扫取消、恢复失败下配置保存，以及按 Cindy 方式 require 后服务 JSON-RPC。完整本地日志在 `.logs/`，不公开提交。

Orca Worker reviewer 首轮核验指出登录未持久化、旧包、错误码形状与扫码超时等缺口；第二轮确认这些已修复，又发现断开/未知发送的占用清理及失败断开的状态不一致。0.1.2 将请求清理统一到 cancelBot/finish；将准备、密文提交、完成或回滚都放进已有 StateStore 串行队列。断开清理失败不报告成功：原登录保留，明确提示重启仍会恢复。状态模型见 lifecycle.md。0.1.3 已由 Orca Worker reviewer 四轮复核，源码/模拟终态 PASS。Lead 随后修正磁盘写入失败的恢复文案、同步说明并补半写回归测试（35 → 36），本地门禁通过。真实运行验收单列。

首次安装曾被取消，之后用户自行安装本地副本，并反馈无法选择伙伴。实际调用已安装插件 list_bindings 得 NODE_TIMEOUT（configure 等待超时）；直接读取 0.1.128 宿主 nodeRuntimeWorkerProcess 发现 createRequire 加载入口，与旧 require.main 条件不相容。0.1.2 改为独立入口无条件启动服务器，并增加 require 加载回归测试。显示名/命令改为“微信伙伴”，保持 id 和数据身份；showTaskPreferences:false 隐藏模型配置，所有投递直接指定伙伴、继承接收方设置。

公开 /secrets 通道在固定源码 electronSandboxAdapter.ts:701 的同分区协议处理器提供，按请求路径/方法分派，不限制 settings 页面。此为源码契约核对，不能代替真实权限验收。

用户自行安装的旧副本已确认为 local；实际伙伴读取因旧入口 configure 超时而失败。0.1.2 更新请求再次返回 MUTATION_CANCELLED，未重试；当前已安装副本没有更新，不能称其伙伴选择/名称/模型卡已修复。0.1.3 源码中显示名、命令、面板标题统一为“微信伙伴”，隐藏模型配置；后台启动修复及模型继承通过模拟与 require 入口测试。

真实伙伴列表、扫码、“微信 → 伙伴 → 微信”及完整退出重开 Cindy 后免扫码仍待用户导入新包或重新明确要求更新后验收，不能以模拟结果代替。GitHub 推送另行记录。
