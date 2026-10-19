# dsh-shell-progress

[English](https://github.com/9087/dsh-shell-progress/blob/main/README.md) | 中文

<!-- 徽章。`ci.yml` 与 `harness-matrix.yml` 都跑在 `main` 上，所以它们的徽章跟着 main 走。
     `release.yml` 是 TAG 触发的，在分支上没有状态（分支徽章会显示 "no status"），
     所以它钉在 tag 上：每次发版都要把下面的 `?branch=v0.6.1` 一起改。 -->
[![npm](https://img.shields.io/npm/v/dsh-shell-progress)](https://www.npmjs.com/package/dsh-shell-progress)
[![许可证](https://img.shields.io/npm/l/dsh-shell-progress)](https://github.com/9087/dsh-shell-progress/blob/main/LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20.11-339933)](https://github.com/9087/dsh-shell-progress/blob/main/package.json)
[![ci](https://github.com/9087/dsh-shell-progress/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/9087/dsh-shell-progress/actions/workflows/ci.yml)
[![harness matrix](https://github.com/9087/dsh-shell-progress/actions/workflows/harness-matrix.yml/badge.svg?branch=main)](https://github.com/9087/dsh-shell-progress/actions/workflows/harness-matrix.yml)
[![release](https://github.com/9087/dsh-shell-progress/actions/workflows/release.yml/badge.svg?branch=v0.6.1)](https://github.com/9087/dsh-shell-progress/actions/workflows/release.yml)

这是一款 DeepSeek Harness 插件：在工具调用卡片里用一条分段进度条，让用户看清一条多步 shell 命令**此刻走到了哪一步**。

<!-- 用绝对地址而不是 `docs/assets/running.zh.png`：npmjs.com 渲染的是发版时快照下来的
     README，并不提供仓库文件树，相对路径在那里是裂图。图片本身仍在仓库里，由
     `pnpm run e2e` 每次重写，所以这个 URL 会跟着代码走。 -->
![四步命令运行中的卡片：分段进度条部分填满、正在执行的那一步带着计时、已完成步骤的输出在其下方，后面是尚未开始的步骤](https://raw.githubusercontent.com/9087/dsh-shell-progress/main/docs/assets/running.zh.png)

*真实的卡片（展开态），`3/4` 已完成、第 4 步执行中。*

## 功能

卡片收起时也在标题行上显示一排分段进度条，一段对应一个顶层步骤，每段是「待执行 / 执行中 / 已完成」三种状态之一，旁边是 `3/4` 这样的计数，不展开卡片就能看出命令跑到哪了、还剩几步。悬停任意一段，弹出该步卡片，显示了对应的命令行、输出和耗时。

![悬停第一段时弹出的卡片：命令行上方一行说明，下面是该步的输出和耗时](https://raw.githubusercontent.com/9087/dsh-shell-progress/main/docs/assets/hover.zh.png)

悬停卡片会在命令行上方以注释的形式写一句该步骤的说明，帮助理解这条命令的意图。（说明由模型生成，与命令并行、不会让命令等待；同一条命令只生成一次，赶不上记录的会在首次悬停或展开卡片时补生成。可在 DSH 设置页的「命令进度」里关掉，默认开启。）

展开卡片后是这条命令的步骤清单，每一步一行，写着该行命令，以及其耗时和输出；正在跑的那一步带一个走动的计时。

无法切分或拒绝跟踪的命令仍然算"一步"：进度条照常画一段，标题后面带一个 `!`，悬停说明它没有被切分、进度只代表整条命令；命令本身按原样执行，输出也受上面的 `maxStepOutputChars` 预算约束。

## 安装

在 DSH 的「插件」页点「添加插件」，填 `dsh-shell-progress`（就是 npm 包名）安装即可。

也可以用命令行：

```sh
dsh plugin --profile web add dsh-shell-progress
```

或者手工挂到 profile 的 `cordis.patch.yml` 里：

```yaml
- insert:
    - id: shell-progress
      name: dsh-shell-progress
```

无论哪种方式，装完都要重启 `dsh web`（宿主只在启动时加载一次插件）。

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

## 开发

开发、测试与发布的细节见 [DEVELOP.md](DEVELOP.md) 与 [PUBLISH.md](PUBLISH.md)。

## 许可

MIT
