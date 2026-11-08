# 验收记录

目标宿主：本机 Cindy 0.1.128；源码 tag v0.1.128，commit `9d62b213c960c63daa46996de8a606965f2f2299`。

## 0.3.6 失败输入由新消息替换或合并（2026-11-08）

用户随后明确要求更新插件并提交推送。Forge 原位更新回执为 updated、version 0.3.6、namespace local、instanceId _ns__local__wechat-companion、enabled true。运行 list_bindings 确认 0.3.6，瑶瑶/喵喵/璐璐三组原配置、伙伴绑定与已有联系人保留，均 connected，credentialStorage sealed，dispatchRetries 为空，recoveryError/capabilityError/storageWarning 均 null。三组 lastErrorCode 为 TIMEOUT；未据此判定网络或模型根因，也未将连接状态当作真实微信收发验收。本轮未主动发送真实微信。

同一 Bot、同一联系人、同一连接代次的新输入到达时，retry_wait 中的重复内容由新请求替换；不同内容以空行按原顺序合并，相同的重复片段保留最新一次，图片按字节内容去重。使用最新请求编号及其 Node 原始微信上下文回传一次。超过 16000 字符或 4 张图时不截断，保持原队列。已 accepted 的输入不参与合并；Bot/联系人不同不合并，合并不跨越其他联系人排队消息。

send 尚未调用时直接取消本地重试；曾调用则先用旧 wx-requestId 查询回执，found:false 或可靠匹配的 pending 才调用 targets.cancel。cancelled 且 settled 才立即放行；撤回 ACK 丢失或未结算时进入 withdrawing，按 1/5/15 秒退避查询匹配的 cancelled+settled，后续同联系人内容继续暂存合并。权限/不支持/无效查询停止轮询并保持等待；不能确认撤回时不换键盲发，需在 Cindy 查看处理。旧回调、旧请求回传、重置/换绑/重连后的迟到结果不能复活被替换的输入。合并的旧 Node 请求释放图片但不计发送失败。

110/110 自动测试、构建、生成入口语法检查与 git diff --check 通过。覆盖相同替换、不同合并、图片差异/去重、长度/图片数边界、已接受回执/查询失败/缺 cancel、投递中并发新消息、撤回未结算/ACK 丢失、旧计时器/查询迟到、重置/换绑，以及编译 main.js 到真实 BotManager 的合并后仅回复一次、最新 contextToken 和联系人路由验证。此阶段未发送真实微信、未安装或发布（后续安装见本节顶部）。Forge 已校验并生成 wechat-companion-0.3.6.cindy，scripts/verify-package.ps1 确认包内 9/9 文件 SHA256 与当前构建一致。

宿主仍为 Cindy 0.1.128。运行构建 sourceCommit=742af4c3f3f477eac7dd796bfbac794390548253，公开源码定位限制沿用 .logs/feas/evidence.md；cancel/get 使用随包公开契约及已安装 asar 缓存中相同实现，不以本地 HEAD 替代运行构建。

## 0.3.5 主动发送微信（2026-11-07）

用户从微信给喵喵发新消息后明确要求再次测试。list_bindings 确认喵喵已接收 1 条消息，出现已知联系人和 defaultPeerId，credentialStorage sealed、连接正常。通过同一个 local 实例 send_to_wechat 指定喵喵及该已知联系人，发送注明用途的主动通知测试文字，真实返回 ok:true、delivered:true、chunks:1、images:0；Bot 与联系人回执和所选目标一致，没有调用 reply_to_wechat。此项确认真实微信发送接口成功；未以接口回执推断用户已阅读、真实图片发送或完整重启后的端到端行为。

用户随后明确要求安装并实测。Forge 返回 updated、version 0.3.5、namespace local、instanceId _ns__local__wechat-companion、enabled true。list_bindings 确认运行 0.3.5，瑶瑶和喵喵两组原配置与伙伴绑定保留、connected，credentialStorage sealed，recoveryError/capabilityError/storageWarning 均 null。两组 peers 为空、defaultPeerId 为 null。通过 local 实例 send_to_wechat 向喵喵默认联系人发送注明用途的测试文字，真实返回 WECHAT_PEER_NOT_KNOWN：“没有该微信联系人的发送上下文，请先让对方给这个 Bot 发一条消息。” 本次没有发送到微信；需用户先在微信给该 Bot 发一条新消息建立上下文，随后再做主动发送验收。没有重试、重扫、伪造联系人或迁移内置微信账号。

用户明确指向 Cindy“IM 机器人 → 个人微信”，已实测内置功能可以主动发送。本次只读核对相邻 dev_cindy/cindy 的 WechatIM.sendText，并用 git show 在上述固定 commit 核验同一路径：当前任务 contextToken 不存在时从 WechatTaskStore.getLatestPeerContext 读取已加密保存的上下文；工具 providers.ts 依次选择当前渠道、当前会话或最近联系人。插件的 NO_CURRENT_REQUEST 来自 ReplyRouter.reply 主动拒绝无当前 entry，是回传限制，不是微信协议不支持主动发送。

新增 send_to_wechat，复用现有文字/图片分块和发送回执链路。伙伴按宿主 session_context 与保存的会话映射匹配自身绑定；桌面任务显式选 Bot。Node 只选本 Bot 已知联系人，默认最近联系用户，可指定已有 peer_id；准备阶段固定联系人及连接代次，后续新输入不改投。联系人最新上下文限制为最近 8 位，和登录一起 AES-256-GCM 保存，旧登录格式兼容。暂停保留上下文，换绑、更换账号、断开或凭证失效清除。原回传仍校验当前请求，主动发送不消费微信请求。

修复 main 的工作进程恢复清空会话映射后未恢复说明回执映射的问题。新版说明单独声明主动发送工具；旧完成说明显示“更新伙伴说明”，只有用户操作时发送一次，升级/刷新状态不自动联系伙伴，不阻塞旧说明已完成的普通收发。

构建、101/101 自动测试、生成入口语法检查和 git diff --check 通过。新增源码及编译 main.js 的模拟验收覆盖无当前请求、不同 Bot/伙伴隔离、最新与显式已知联系人、陌生联系人拒绝、旧登录兼容、加密保存/新进程恢复、同/不同微信账号重扫、图片准备期间新联系人/换绑、主动发送不消费输入、同 callId 幂等和未知发送不重试。打包阶段未安装或发送真实微信；后续安装与文字主动发送结果见本节顶部，未发布。发送去重和发送回执只在内存，跨调用或重启不保证去重。

## 0.3.4 转交伙伴失败后两次延迟重试（2026-11-07）

按用户追加要求，ReplyRouter 保留初次转交失败的原输入，等待 3 分钟重试一次，仍失败则再等 10 分钟重试一次。每次重用 wx-<requestId>、原文字/图片和目标伙伴，依赖宿主同键幂等投递。成功停止重试；同 Bot 保持 lane 顺序，其他 Bot 独立。失败重试耗尽才通知 Node 拒绝并释放图片/占用。授权拒绝、接口不支持、无效请求、请求键冲突及过期不重试；投递不确定同键重试而不换键，仍未知则显示 DISPATCH_DELIVERY_UNCERTAIN。微信端回复发送仍不重试。

绑定说明检查移至每次转交前执行，正常处理仍沿用一分钟等待，暂未就绪或查询失败也按转交计划重试。snapshot 给面板返回 Bot 标识、次数、下一次时间，不返回原文/图片/凭证。停用、换绑、连接重置、Node stopped/crashed、reset/finish 清重试定时器；重试只在内存，重启不恢复，仍沿用请求 30 分钟期限。

构建、91/91 自动测试和生成入口语法检查通过。新回归用模拟计时器验证精确 180000/600000 毫秒间隔、第一次/第二次恢复、原图片/文字不变、同 Bot 排队、不同 Bot 独立、同键受理回执丢失、最终失败释放、旧回调/取消/过期、授权拒绝和绑定说明再检查。编译后的 main.js 通过 Host 模拟真实入口，还验证 Node 输入重试期间保持 pending、面板显示第 1/2 与 2/2 次、成功后的伙伴回传，以及 Node stopped 取消重试。未通过真实微信故障或实际等待 3/10 分钟执行端到端验收。

Forge 校验打包 0.3.4，9/9 包内文件 SHA256 与当前构建一致；原位安装返回 updated、namespace local、version 0.3.4、enabled true。随后 list_bindings 确认实际运行 0.3.4，两组 Bot connected、lastErrorCode null、原配置/伙伴绑定不变、绑定说明 ready、credentialStorage sealed、dispatchRetries 空，recoveryError/capabilityError/storageWarning 均 null。本次未主动发送真实微信或伙伴消息，运行状态检查不替代端到端验收。

## 0.3.3 语音直接提示转换为文字（2026-11-07）

按用户要求，所有 type=3 语音消息（包括带 voice_item.text 的消息）整条拒绝，不交给伙伴。插件使用收到的原 peerId/contextToken，直接发送固定文字“暂不支持语音，请使用微信语音转文字后发送。”。微信转换后发送的 type=1 文字照常处理。混合消息中的图片不下载，正文不部分转交。面板显示 VOICE_UNSUPPORTED；成功提示计入回复数，语音计入拒绝数。

沿用原消息去重、游标和加密登录存储；实际轮询先保存接收进度再发送一次提示。同一消息和同一提示调用不重复发送；发送结果不确定显示 DELIVERY_UNCERTAIN，不重发、不把它当连接故障，继续处理后续消息。保存失败或保存期间停用/换绑时不发送提示。崩溃发生在保存后、发送前时可能没有提示，没有新增无人值守交付保证。

本地构建、全部自动测试、产物语法检查及 git diff --check 通过。新增回归通过实际 pollLoop 验证原用户路由、无识别文字/有识别文字/混合语音、转换后的文字、先保存后提示、重复去重、发送未知继续下一条、保存失败及保存期间停用；既有图片下载失败回归的后续输入改为普通文字。测试模拟微信接口，不代表真实微信端到端成功。

Forge 校验打包 0.3.3，9/9 文件 SHA256 与当前产物一致；安装返回 updated、version 0.3.3、namespace local、enabled true。首次状态查询出现 PROCESS_START_FAILED（Node 启动超时），随后同实例 list_bindings 成功：两组 Bot connected、原配置/绑定说明 ready、credentialStorage sealed，recoveryError/capabilityError/storageWarning 均 null；lastErrorCode 为 TIMEOUT，未据此推断网络或启动超时根因。

## 0.3.2 纯正文与一次绑定说明（2026-11-07）

用户明确取代先前“来自微信”和逐条 context 方案。src/core.mjs 直接派发 entry.text，不发送前缀、编号或 context；图片附件及语音识别文字保留。绑定说明使用普通 targets.send，Host 在 register.ts 的适配器从已安装插件名生成 sourcePlugin，并沿队列保存；messageSource.ts 生成 [消息来源]“由插件…(plugin_id: …)发送”，messageSourceNote.ts 只在模型 wire 上添加，不写入正文或系统提示词。agentInputQueue.ts 明确同一 Host 元信息驱动 UI“由插件「X」发送”标签。基于固定 v0.1.128 commit 9d62b213c960c63daa46996de8a606965f2f2299 的 8 项契约探针通过，日志在 .logs/v032/contract-probe.log。运行构建证据仍以 .logs/feas/evidence.md 的 asar/tag 对照为限，不用本地 HEAD 替代。未真实联系伙伴或微信。

新增 BindingGuides 保存非秘密的原 requestKey/伙伴/会话/阶段到插件 KV，发送前先持久化键；重复保存、改名、暂停恢复与重启不重发，换绑使用新说明。说明本身不创建微信 entry，不带委派，不调用回传；发说明前检查同 Bot 无当前微信请求。旧绑定不在启动或查看时自动联系伙伴，卡片提供“发送伙伴说明”；正常处理中共享等待查询，输入暂存在内存，计时预算一分钟（查询耗时另计），完成后继续派发。缺少/失败/未知或等待超时明确拒绝，用户处理后重发。普通说明回执 completed 仅表示处理轮次完成，不能证明写入长期记忆。投递未知先核实旧键，只有主人显式 retry 且可靠 terminal 失败才开新说明尝试；found:false 时重试仍用原键。

reply_to_wechat 的 request_id 改为可选，Host 签发 session_context 匹配唯一启用绑定与当前有效请求，无候选/无当前/歧义/过期拒绝。原显式编号、session 身份、每 Bot lane、settled、TTL、图片及发送幂等保留；同一 callId 锁定原请求或拒绝结果，避免配置说明调用被重试后改投新消息。缓存只在内存且有上限，不同 callId 的过时调用及 canonical 桌面轮次仍可误用推进后的当前请求；一次说明不能构成 turn 身份或自动镜像硬保证。

新增回归涵盖纯文无 context、说明仅一次/换绑/重启、未知投递对账、失败显式恢复、配置说明无当前不能回传、busy 禁止插入说明、伙伴身份唯一/歧义、旧编号及 implicit callId 幂等。真实折叠取消后的界面、宿主插件来源标记与模型处理、伙伴记忆遵从、普通说明的真实终态和文字/图片/语音微信端到端仍待 reviewer/实机验收；这里只进行模拟、源码核对与打包。

npm run build、npm test（81/81）、npm run check、git diff --check 通过，完整输出在 .logs/v032/。Forge 校验生成 wechat-companion/wechat-companion-0.3.2.cindy，包内 9/9 SHA256 与当前源码一致。Git 只读确认 main 和既有 origin，日志/缓存/研究数据/包不纳入公开源码；公开排除建议在 .logs/v032/public-exclusion.md。未安装、未发布、未真实联系伙伴或微信，未提交或推送。

## 插件内输入与回执收口（0.3.0 历史，2026-11-07）

沿用 `.logs/feas/evidence.md` 的只读可行性结论：运行构建的 sourceCommit 未能在公开仓库核实，已安装 asar 的关键接口与上述公开 tag 一致；未以本地 HEAD 代替运行版本。本次仅修改插件，不修改宿主、不新增权限、不读取伙伴历史、不安装或发送真实微信。公开 targets.get 只提供关联完成状态与 outputMessageId，不提供答案正文，will-assistant-message 不覆盖伙伴 source=bot，因此本次没有自动回复镜像。

dispatch 探测 tasks.capabilities().messageContext===true：支持时可见 text 严格为“来自微信：”加收到的原文，request_id、必要的 reply_to_wechat 步骤和图片规则进入 context；不支持或文字能力查询失败时保留可见说明。图片能力不足仍拒绝交接，不静默丢图；语音转文字、图片分块与凭证行为保持。

仅同时支持 receiptQuery、settled 和 targets.get 才开始按原 requestKey 查询，并核对目标、会话和已有 executionId。已结算且仍 accepted、replyKey 未预留时标记 settled，finish 释放 lane，再通知 Node 拒绝旧请求；按可靠 outcome 区分完成未回传、失败、取消与中断，缺少或未知 outcome 使用中性的 ENDED_WITHOUT_REPLY，不计微信发送成功。这些是请求级提示，不修改连接状态或建议重扫。图片读取前同步预留 replyKey，正常读取、上传/发送与未知发送回执不被完成查询取消。取消、重置或更换请求后迟到查询失效。权限拒绝停止查询；缺能力、未知完成或查询错误均不重投、不伪造成功，保留 TTL。

本地 npm run build、npm test（72/72）、npm run check 已通过，完整输出位于 `.logs/input-receipt/`。新增定向测试覆盖严格正文/context、能力回退、完成释放/迟到拒绝、错误/未知及关联不符的回执、查询与发送竞态、图片读取成功/失败、发送未知后的幂等、取消后的迟到查询、TTL 与两 Bot 隔离。编译 main.js 模拟宿主还验证 session_context 身份、图片 RPC 限制，以及桌面 will-assistant-message/did-turn 事件与完成回执不会触发微信发送。测试中显式禁止 companions.reply/history。工作区同时存在管理界面并行改动，门禁针对当时合并后的工作树执行；本节不代表其独立 UI 验收。

独立 reviewer 在 `.logs/reviewer-feature/review.md` 确认核心门禁 72/72，并指出未回传错误缺少 UI 映射导致连接误报。本次修复按 outcome 分码并增加请求级提示，沿用 Node 已有的 lastErrorCode 传递，不改变 connected/status；手册区分 REQUEST_SETTLED、REQUEST_EXPIRED 和竞态可能的 DELIVERY_UNCERTAIN。此前实施报告“13 项 router 测试”不准确，原文件实际为 12 个 test 块，本次扩展其中一个 outcome 回归，仍保持 12 块；另补 1 个宿主到 Node 状态到实际 settings.js 卡片渲染的回归，不为测试数凑项。

修复后 npm run build、npm test（73/73）、npm run check、router 定向测试（12/12）、git diff --check 与重新 Forge pack 均通过。新包仍为 `wechat-companion/wechat-companion-0.3.0.cindy`，9/9 文件 SHA256 与当前源码一致；完整输出在 `.logs/input-receipt-fix/`。卡片回归执行真实编译后的 settings.js render 函数，DOM 为模拟，未宣称真实视觉或微信端到端通过。后续独立 reviewer 复验待 Lead 安排。

Forge 校验并生成 `wechat-companion/wechat-companion-0.3.0.cindy`，包内 9/9 个文件 SHA256 与当前源码一致（pack.log、package-identity.log）。打包不安装；本次没有安装、发布、提交或发送真实微信。

残余窗口：首次 1 秒，随后查询结束后等 5 秒，再每次等 15 秒；查询耗时或失败会扩大窗口，权限拒绝时退回 TTL。伙伴 canonical 会话与桌面共用；完成被查询观察到之前，同一伙伴桌面轮次若误用仍有效的旧 request_id，仍可能通过会话级身份校验。插件不会自动监听/镜像桌面输出，但不能声称杜绝所有误用旧编号；彻底解决需要宿主提供 turn/input 级关联。

待真实验收：0.1.128 中折叠附带资料的显示、模型是否读取资料并在本轮结束前调用 reply_to_wechat、真实完成结算时序、扫码后文字/图片/微信语音文字端到端，以及与伙伴桌面交谈交错的行为。真实运行、明暗主题和手机显示不能由模拟测试替代；后续由 Lead 安排 reviewer 验收，当前尚未安装本次构建。

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
