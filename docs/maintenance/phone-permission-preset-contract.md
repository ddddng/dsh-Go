# 手机操控跟随会话完全权限

## 原因与接线

会话的 `danger-full-access` 由引擎 `permissionPresets` 服务管理，手机的
`confirmMode` 由原生管理。此前 managed phone 调用只传调用归属，原生无法知道
当前会话已经选了完全权限，因此仍可能要求逐次确认。

`phone-permission-preset.diff` 在 `dsh-mcp-client` 真正派发工具时，从
`execution.agent.ctx.get('permissionPresets').current(execution.agent.session)`
读取有效权限，将可选字符串 `permissionPreset` 放入
`_meta['dsh-go/phone-caller']`。它与 `sessionId`、`runId`、`callId` 同属
宿主生成的调用信息；模型的工具参数不能替换这些值。

读取发生在每次派发，而不是任务创建时。普通工具调用与代码内嵌套的工具调用
都使用自己的 Agent；同一轮中改变权限也在下一次派发时生效。调用身份与结束
通知的现有协议不变。缺少权限服务时省略新字段；没有 managed phone 开关、
所属会话或手机端能力协商时，保留原有消息。

原生按单次调用读取该字段，只有 `danger-full-access` 表示会话已允许免确认。
不得把它写成全局 `confirmMode`，也不得在排队入场时覆盖同任务正在执行的
调用权限。其他权限值继续使用手机确认设置。手机总开关、设备能力、应用名单
等设置仍由原有入口管理。

Android 将 `permissionPreset` 保存在单次 `Admission` 中，执行时创建该调用的
`SafetyGate`。视觉授权、任意坐标点按、长按、滑动和焦点输入共用这一免确认
判断；驱动回调也捕获同一个 gate，不会被后面排队的调用覆盖。

iOS 的内置手机桥直接从实际 Agent 读取相同权限服务，将 `permissionPreset`
放入原生请求顶层。`IOSPhoneTaskConsent` 在完全权限下直接建立任务授权，
授权同时绑定引擎、会话和权限档位；切回其他档位后不能复用完全权限的授权，
会重新走原生确认。截图和坐标点击不再额外要求用户同意。

## 补丁与验证

锁定版本为 DSH `0.2.2-rc.1`。npm 包的实际入口是
`@deepseek-ai/dsh-mcp-client/lib/index.js`；该包未另发运行用的
`lib/types/tools.js`，所以补丁直接修改实际加载的打包入口，既有 batch/PTC
模块无须改动。补丁位于共同补丁链末尾，登记到 Android 与 OHOS 两个
`targetSets`，OHOS 后续 MCP 补丁只重新记录连接后的哈希。

```bash
DSH_PREFIX=<已应用补丁的前缀> node --test \
  runtime/tests/phone-permission-preset.test.mjs \
  runtime/tests/phone-caller-context.test.mjs
python3 -I runtime/tests/test_patch_dsh.py
node --test runtime/ios/phone/bridge.test.mjs \
  runtime/ios/phone/bridge-browser.test.mjs runtime/ios/phone/bridge-system.test.mjs \
  runtime/tests/ios-phone-descriptions.test.mjs
```

`phone-permission-preset.test.mjs` 使用真实权限服务、会话、工具执行器和
stdio MCP 传输，覆盖两个会话、参数伪造、延迟派发、同轮降权、嵌套调用和
旧端兼容。手机端是只回显元数据的测试进程，不执行设备操作；实际截图、
坐标点击与确认界面另由原生测试和真机验证覆盖。

Android 回归在 `PhoneCallerTest`、`PhoneTaskSessionsTest`、
`PhoneVisualPermissionTest`、`PhoneCorePromptOwnerTest`；iOS 原生回归在
`IOSPhoneTaskConsentTests`。后者需要 Apple 测试环境，不能以 Node 桥接测试
通过代替原生确认界面的验证。

重新记录时，从 `runtime/locks/dsh-0.2.2-rc.1` 的锁定依赖创建两个未打补丁
的独立前缀，分别运行：

```bash
python3 -I runtime/lib/rtbuild.py patch-dsh --prefix <原始 Android 前缀> \
  --dsh-version 0.2.2-rc.1 --target android --record
python3 -I runtime/lib/rtbuild.py patch-dsh --prefix <原始 OHOS 前缀> \
  --dsh-version 0.2.2-rc.1 --target ohos --record
```
