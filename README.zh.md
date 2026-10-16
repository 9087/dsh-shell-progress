# dsh-shell-progress

[English](https://github.com/9087/dsh-shell-progress/blob/main/README.md) | 中文

<!-- 徽章。`ci.yml` 与 `harness-matrix.yml` 都跑在 `main` 上，所以它们的徽章跟着 main 走。
     `release.yml` 是 TAG 触发的，在分支上没有状态（分支徽章会显示 "no status"），
     所以它钉在 tag 上：每次发版都要把下面的 `?branch=v0.3.0` 一起改。 -->
[![npm](https://img.shields.io/npm/v/dsh-shell-progress)](https://www.npmjs.com/package/dsh-shell-progress)
[![许可证](https://img.shields.io/npm/l/dsh-shell-progress)](https://github.com/9087/dsh-shell-progress/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20.11-339933)](https://github.com/9087/dsh-shell-progress/blob/main/package.json)
[![CI](https://github.com/9087/dsh-shell-progress/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/9087/dsh-shell-progress/actions/workflows/ci.yml)
[![harness matrix](https://github.com/9087/dsh-shell-progress/actions/workflows/harness-matrix.yml/badge.svg?branch=main)](https://github.com/9087/dsh-shell-progress/actions/workflows/harness-matrix.yml)
[![release](https://github.com/9087/dsh-shell-progress/actions/workflows/release.yml/badge.svg?branch=v0.3.0)](https://github.com/9087/dsh-shell-progress/actions/workflows/release.yml)

一个 DeepSeek Harness 插件：在**工具调用卡片里**用一条分段进度条显示**一条多步 shell 命令现在跑到哪了**。

一次调用，一张卡——这是运行中的实拍，不是手画的示意图：

<!-- 用绝对地址而不是 `docs/assets/running.zh.png`：npmjs.com 渲染的是发版时快照下来的
     README，并不提供仓库文件树，相对路径在那里是裂图。图片本身仍在仓库里，由
     `pnpm run e2e` 每次重写，所以这个 URL 会跟着代码走。 -->
![四步命令运行中的卡片：分段进度条部分填满、正在执行的那一步带着计时、已完成步骤的输出在其下方，后面是尚未开始的步骤](https://raw.githubusercontent.com/9087/dsh-shell-progress/main/docs/assets/running.zh.png)

*真实的卡片（展开态），`1/4` 已完成、第 2 步执行中。*

它回答的问题是*「这条命令还在跑，还是卡住了？」*——所以实时位置是功能本身，不是附赠品。
进度条位于**收起态**的卡片里：扫一眼对话流就够了，把它藏进折叠区就变成了两步交互。

## 安装

```sh
dsh plugin --profile web add dsh-shell-progress
```

或者手工挂到 profile 的 `cordis.patch.yml` 里：

```yaml
- insert:
    - id: shell-progress
      name: dsh-shell-progress
```

然后重启 `dsh web`（宿主只在启动时加载一次插件）。

## 模型看到什么

什么都不变。`shell_progress` 注册的工具，其模型可见文本与 `pwsh` 工具跑同一条命令
**逐字节一致**：同样的 stdout、同样的 `[stderr]` 段、同样的 `[exit code: N]` 标记。
步骤信息从不进入对话，它走工具结果的 `presentationMeta`，由宿主持久化到 `tool/result` 事件上。

模型能读到的地方没有 nonce、没有标记、没有重排序。

## 配置

```yaml
- insert:
    - id: shell-progress
      name: dsh-shell-progress
      config:
        enabled: true
        pollIntervalMs: 120
        maxStepOutputChars: 8192
        maxSteps: 400
        liveRetentionMs: 300000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 是否注册 `shell_progress` 工具。 |
| `pollIntervalMs` | `120` | 宿主读取运行中进程输出的间隔。 |
| `maxStepOutputChars` | `8192` | 每步输出在持久化进度里保留的字符数。 |
| `maxSteps` | `400` | 超过此步数的命令按原样执行。 |
| `liveRetentionMs` | `300000` | 已结束调用的实时记录保留多久，供迟到的轮询读取。 |

某个步骤的输出超过 `maxStepOutputChars` 时，装不下的行会从**卡片**的副本里丢弃，并在该步输出
下方写明**少了多少个字符**（步骤列表和分段的悬浮卡里都写）。否则一个被截断的步骤看起来和
"输出很少的步骤"一模一样。这个预算只属于卡片，不属于工具结果：模型可见的 stdout 来自 shell
seam 本身，不受它影响（seam 自己的 `truncated` / `spillPath` 照旧生效）。

## 工作原理

1. **切分**：只在**顶层步骤**打点——非空行、起始于第 0 列、不以 `}` 开头、花括号深度为 0。
   计数时跳过单引号串、双引号串（含反引号转义）与 `#` 注释。循环体永远不是步骤，
   所以迭代多少次都只产生一个标记。
2. **插桩**：标记前缀在该步骤自己那一行，**不新增行**，其余行逐字保留。
3. **执行**：插桩后的文本走 `ctx.shell`，与 `pwsh` 工具完全同路——同样的超时、
   沙箱策略、受管环境与取消语义。
4. **跟随**：命令运行期间读增量输出，把每个标记变成「当前步骤」，并用**单调时钟**打时间戳。
5. **持久化**：每步起止时间与输出走 `output.presentationMeta`，
   因此重新加载会话后，整张卡片可以只凭会话日志复现。

### 埋点必须内联

`src/instrument.ts` 里有完整说明；一句话版：PowerShell 里**函数调用本身也是一条命令**，
它会覆盖 `$?`。所以把埋点写成辅助函数，就会悄悄改掉被插桩命令读到的值——
而且调用方之后读到的 `$?` 是**辅助函数的成功状态**，即使在函数内部捕获并恢复也无济于事。
本机实测（Windows PowerShell 5.1，即未装 PowerShell 7 时 shell 能力缝实际解析到的那个）：

| 埋点形态 | 紧接失败命令之后的 `$?` |
|---|---|
| 不插桩（对照） | `False` ✅ |
| 辅助函数（内部捕获+恢复） | `True` ❌ |
| **内联捕获+恢复** | `False` ✅ |

`tests/powershell.spec.ts` 会把两种形态都真的跑一遍并断言这个差别，
所以将来若有人把埋点重构成函数，测试会失败。

## 什么时候不跟踪

以下任一条件成立时，命令**按原样执行**，并且**不写任何标记**：

- 切分器遇到无法判定的结构（未闭合引号、块注释、here-string、续行符、花括号或圆括号不平衡）；
- 命令里已经出现本方案的标记形状，或已经使用 `$__ok`；
- 解析出的沙箱模式是 `read-only`；
- 步数超过 `maxSteps`。

被拒绝的调用，卡片是**朴素形态**：命令 + 它的全部输出，没有进度条、没有计数器、没有步骤行。
也没什么可画——一个标记都没写，所以没有任何一步拥有自己的计时或输出；规划器"尽力而为"的
步骤表会被丢弃，而不是渲染成永远只能读作"待执行"的行。拒绝的**原因**写进**宿主日志**
（`shell-progress: running the command unmodified — …`），不放在卡片上。

**只有一步**的命令同样不插桩——没有先后可排，也就没有东西可标——但它的卡片并不降级：
宿主会给那一步盖上真实的开始与结束时间，所以进度条照样画出它那一个分段，
并按 待执行 → 执行中 → 完成 变化，旁边带着这条命令的计时。

以上都不是错误：模型拿到的与 `pwsh` 原本会给出的完全一致。

## 结构

| 半边 | 源码 | 运行环境 |
|---|---|---|
| Host | `src/index.ts`（以及旁边的纯函数模块） | DSH 宿主进程（Node） |
| Client | `src/client/*`（React） | 浏览器 |

两边只共享 `src/types.ts` 与 `src/split.ts`，别无其它。

**实时通道是轮询，不是推送。** 安装在 DSH 仓库之外的插件收不到宿主事件
（转发事件白名单是构建里的静态数组），所以浏览器在调用进行期间每隔约 250ms
向本插件自己的已认证请求/响应通道 `/shell-progress` 问一次。已结束的状态不需要轮询：
它本来就在会话日志里。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

顶部的三个 workflow 徽章就是这三个：

| Workflow | 它做什么 |
|---|---|
| [`ci.yml`](.github/workflows/ci.yml) | 用 `devDependencies` 里钉死的 harness 版本做类型检查、构建并跑单元测试——**一个**宿主版本，也就是本仓库声明的那一个。 |
| [`harness-matrix.yml`](.github/workflows/harness-matrix.yml) | 把三个跨「插件/宿主」边界的套件（经 `apply` 注册的工具路径、pwsh planner、bash planner）**在每个已发布的 harness 版本上各跑一遍**——这是「宿主升级之后还能用吗」的唯一真实答案。声明 peer 范围内的版本是阻塞项；最新已发布版本作为非阻塞探针同行。 |
| [`release.yml`](.github/workflows/release.yml) | 推 `v*` tag 时：跑同一套门禁，然后经 Trusted Publishing（OIDC，无需任何 token）执行 `npm publish --provenance`，再建一个 GitHub Release。 |

详见 [DEVELOP.md](DEVELOP.md) 与 [PUBLISH.md](PUBLISH.md)。

## 许可

MIT
