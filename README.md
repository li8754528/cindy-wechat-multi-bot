# Cindy 微信伙伴

一个 Cindy 插件管理多个微信 Bot；每个 Bot 固定对应一个不同的伙伴。插件负责微信文字收发，伙伴负责回答，回复只回到原消息渠道。

## 开发

需要 Node.js 22。开发阶段执行 `npm ci --ignore-scripts`、`npm run build`、`npm test`、`npm run check`。构建产物在 `wechat-companion/`；依赖已打进 Node 工作进程，用户安装插件后不需要运行 npm。由 Cindy Forge 打包为 `.cindy`。

最低目标宿主 Cindy 0.1.128。源码按正式 tag v0.1.128 / commit `9d62b213c960c63daa46996de8a606965f2f2299` 核对接口，不依赖客户端私有 IPC。

## 首次使用

安装后打开“微信伙伴”的设置页或“使用”面板。添加 Bot 名称，选择本机伙伴，保存；扫码确认后启用这组收发。收到的消息直接投递给已选伙伴，沿用伙伴自己的模型与权限，插件没有模型选择，也不创建额外任务。伙伴调用 `reply_to_wechat` 回传本次答案，收到与回传计数分别增加。可继续添加第二组并绑定另一位伙伴。

Bot 与伙伴一对一；同一个真实 Bot 账号不能登录到两组配置，也不要同时用于 Cindy 内置连接与本插件。同一 Bot 的消息依次处理，仅当前请求可以回传；不同 Bot 可独立工作。伙伴原有权限保持不变，需要主人处理的请求仍在 Cindy 中处理。

## 骨架版范围

支持多组配置、独立连接、扫码登录、文字收发、请求编号与回传校验。首次登录后，Bot 凭证与接收游标通过 AES-256-GCM 加密保存至 Cindy 插件私有数据目录；密钥自动生成并交给 Cindy 保险库，按声明的方法临时注入 Node。配置、日志、工具结果与模型均得不到 Token 明文。

正常重启、插件更新或工作进程恢复会读取保存的登录，不需要再次扫码。“停用收发”保留该组登录；“断开”先暂停本组并清理保存记录，成功才完成断开。清理失败会保留当前连接并明确报错；磁盘写入中断可能损坏保存文件，重启后需检查状态，必要时重新登录。删除绑定清除对应配置，后续不会恢复已删除的组。重新生成二维码不会清除旧登录，确认新登录并保存成功后才替换。微信凭证失效、保险库不可用或记录损坏会如实报错。

暂不支持图片/语音/文件、混合媒体、额外验证码登录和持久收件箱。重启前正在处理的微信请求不恢复；保存游标后再投递，避免重启重复回答，但崩溃窗口内尚未投递的消息可能需要用户重新发送。发送结果不确定时不会自动重发。自动测试模拟微信与宿主，不能替代扫码后的真实端到端及完整 Cindy 重启验收。实际验收记录见 `docs/verification.md`。

## 目录与接口

`src/core.mjs` 管理伙伴路由与回传身份；`src/main.mjs` 使用 Cindy 公开接口；`src/worker.cjs` 管理多 Bot 连接；`src/state.cjs` 加解密登录；`src/persistence.mjs` 通过 Host 保险库和私有目录保存状态；`src/ilink.cjs` 是文字 iLink 适配器；`src/settings.*` 是设置页。随包用法见 `wechat-companion/manual/getting-started/MANUAL.md`。

协议参考固定版本的 [iLink 客户端](https://github.com/makecindy/cindy/blob/9d62b213c960c63daa46996de8a606965f2f2299/packages/wechat-ilink/src/apiClient.ts) 与 [伙伴目标接口](https://github.com/makecindy/cindy/blob/9d62b213c960c63daa46996de8a606965f2f2299/apps/desktop/src/main/cindy-brain/pluginTargetSlot.ts)。本项目独立实现最小文字协议，没有复制宿主内部代码。
