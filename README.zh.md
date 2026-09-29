# dsh-plugin-model-request-accelerator

**模型请求加速** —— 让 DeepSeek Harness 的模型请求更小、更早出发，并看清每一次请求的时间花在了哪里。

三件事，每件都可以按提供方单独开关：

| | 作用 | 默认 |
| --- | --- | --- |
| **压缩** | 上传前压缩请求体（优先 brotli，退回 gzip） | 关闭 |
| **预传输** | 在需要它的请求存在之前，就把共享的对话历史放上线路，于是每一步只上传自己的增量 | 关闭 |
| **请求耗时** | 在「轨迹」旁提供一个视图，把每次模型调用拆成各个阶段 | 开启 |

> English docs: [README.md](./README.md)

## 目录

- [它做什么](#它做什么)
- [环境要求](#环境要求)
- [安装](#安装)
- [配置](#配置)
- [确认生效](#确认生效)
- [出问题时](#出问题时)
- [更新](#更新)
- [卸载](#卸载)
- [更多](#更多)

## 它做什么

**压缩针对的是上传，不是回复。** 响应本来就是压缩的——Node 的 `fetch` 会带上 `accept-encoding: gzip, deflate` 并自动解压，这部分本插件不做任何事。没被压缩的是**请求**：一个带着长上下文和 base64 图片的 JSON body 会原样上传。本插件缩小的正是这一半。

**预传输针对的是往返。** 多轮请求每一步都会重发整份历史。长历史不会瞬间到达对端，而中转链的每请求开销——token 计数、配额预检、body 日志、WAF 扫描——正比于它已收到的字节数。提前把历史送出去，需要它的那一步只要追加几百字节，而不是几兆。

**耗时视图让你看见发生了什么。** 每次模型调用被拆成准备、发送、服务端、首 token、生成五个阶段，并给出 tok/s 与提供方自己的前缀缓存命中率，于是你能判断上面两件事到底有没有帮上忙。

真实会话的实测：一个 **3.8 MB** 的请求体变成 **1.46 MB**，而最后一步自己要写的只剩几百字节。

**不会替你打开任何开关。** 所有提供方初始都是关闭的。先开一个，确认它确实生效，再考虑下一个。

## 环境要求

- DeepSeek Harness，且所用 profile 带浏览器界面（`web` profile 自带）。
- Node.js >= 20。DSH 自带的那份即可。

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/HolynnChen/dsh-plugin-model-request-accelerator/main/install.sh | sh
```

它会把插件克隆到 `$DSH_HOME/profiles/web/plugins/model-request-accelerator` 并注册进该 profile 的 `cordis.patch.yml`。**可以反复运行**——它会 fast-forward 已有 checkout、保留已注册的条目，并且**绝不覆盖你改过的设置**。换 profile 或换 DSH home：

```bash
DSH_HOME=~/.dsh DSH_PROFILE=web sh install.sh
```

然后**刷新浏览器标签页**（设置页属于页面的模块图，安装时已开着的标签页不会有它），打开 **设置 → 模型请求加速**。

<details>
<summary>手动安装</summary>

**1. 克隆进你的 profile**

```bash
git clone https://github.com/HolynnChen/dsh-plugin-model-request-accelerator.git \
  "${DSH_HOME:-$HOME/.dsh}/profiles/web/plugins/model-request-accelerator"
```

通常不需要单独装依赖：Node 会从插件目录向上找到 profile 自己的 `node_modules`，DSH 的包就在那里。如果你的布局不是这样，在克隆目录里跑 `npm install --omit=dev`。

**2. 注册它**

往 `${DSH_HOME:-$HOME/.dsh}/profiles/web/cordis.patch.yml` 追加（它是一个顶层 YAML 数组）：

```yaml
- insert:
    - id: model-request-accelerator
      name: './plugins/model-request-accelerator/lib/index.js'
```

相对 `name` 是相对 profile 目录解析的，所以换机器也能用。绝对路径同样可以。

**3. 刷新页面。**

</details>

## 配置

所有设置都在一页里：**设置 → 模型请求加速**，与「通用」「模型」「插件」并列。

**两个全局开关**

- **耗时记录** —— 显示账本占用，旁边是 **清空** 按钮。清空不可撤销，并且会同时丢弃运行进程里持有的部分。
- **显示请求耗时视图** —— 关掉它，Host 也会停止记录耗时，因此不需要这个视图的部署不为它付出任何代价。立即生效，无需刷新。

**每个提供方路由一行**

- **开关** —— 是否压缩该提供方的请求。
- **算法** —— `brotli`（默认）或 `gzip`。
- **HTTP/2** —— 对开启了预传输的路由默认打开，其余默认关闭。
- **预传输** —— 默认关闭。

共用同一个 endpoint 的多个路由是**各自独立**配置的，因为每次模型调用会被归属到发出它的那个提供方；只有在请求完全无法归属时才会退回按 endpoint 判断。

如果你更愿意改文件，下面就是同一份设置——即 loader 行的 `config`，设置页帮你写的就是它。但**用页面改更安全**，因为 Host 会按插件 schema 校验，不合法的写入会被拒绝：

```yaml
- insert:
    - id: model-request-accelerator
      name: './plugins/model-request-accelerator/lib/index.js'
      config:
        providers:
          sg:
            enabled: true
            prewarm: true
        encoding: auto
        prewarmHoldMs: 120000
        prewarmPoolSize: 3
        http2: true
        allowInsecureH2c: false
        timing: true
```

每个键的含义都在 **[docs/CONFIGURATION.zh.md](./docs/CONFIGURATION.zh.md)**里，其中有两件事值得在打开压缩之前先读一遍。

### 简短版

- **压缩**需要对端能解码。gzip 几乎无处不在，brotli 不是。如果某个 endpoint 拒绝了 brotli body，插件会自动改用 gzip 重试一次、并记住，此后不再对它尝试 brotli——所以最坏情况是**一次性**浪费一个请求。也可以先问清楚：

  ```bash
  node scripts/probe-encodings.mjs https://your-gateway.example/v1
  ```

- **预传输**需要 endpoint 接受 **chunked** 请求体。不接受的话，它会自己对该 endpoint 关闭。
- **HTTP/2** 不是提速开关。开了压缩之后上传已不是瓶颈；h2 换来的是重复请求的头部压缩，以及让被持有的连接池共用一条连接。网关不支持也没关系——请求会继续走 HTTP/1.1。

## 确认生效

Host 会为每个被压缩的请求打一行日志：

```
model-request-accelerator: sg request compressed 3813841 -> 1461179 bytes
```

打开「轨迹」旁的 **请求耗时** 视图即可实时观察。一行会显示实际使用的算法（`br`/`gzip`）、是否走了预传输（**预热**），以及该请求被持有到被认领的时长——最后这个数字就是**真正赢得的提前量**。

## 出问题时

**模型请求失败或回答异常。** 在设置页把该提供方的开关关掉。改动是实时的、无需重启，而且所有提供方初始都是关的——所以这一步永远可逆。

**开启压缩后请求失败。** 可能是网关不接受该编码。插件会自动用 gzip 重试一次；gzip 也被拒绝时，会为该 endpoint 关闭压缩。endpoint 对压缩 body 回 `411`/`415`/`501` 就是它处理的那种形状拒绝。用 `scripts/probe-encodings.mjs` 先确认，或把**算法**设为 `gzip`。

**预传输没被使用**（没有 **预热** 标记）。要么该请求无法归属到提供方，要么 endpoint 拒绝了 chunked body 因而对它关闭了预传输。后者会显示在设置卡片里；日志里出现 `endpoint-matched` 则是前者。

**HTTP/2 没被使用**（没有 `h2` 标记）。最可能是你的网关不提供它——那样请求会继续走 HTTP/1.1，**并没有出问题**。`h2` 标记**只在响应确实经 h2 返回时**才出现，所以它缺席不等于失败。被插件放弃的 endpoint 会在设置卡片里点名。

**设置页是空的，或保存时报 "overridden"。** 说明插件的配置不在本版本读取的位置。见 **[docs/UPGRADING.zh.md](./docs/UPGRADING.zh.md)**。

**觉得不对劲想退出去。** 从 `cordis.patch.yml` 删除本插件的条目并刷新页面即可，见 [卸载](#卸载)。

## 更新

设置卡片会显示版本号并附一个按钮。**打开卡片时会自动检查**；点 **检查更新** 会重新查一次，并与仓库 `main` 分支上发布的版本比较。远端更新时按钮变成 **更新到 X**，点击即对插件自己的目录做 fast-forward 拉取。

**更新后需要重启 `dsh web`。** Host half 在启动时载入，实时重载不会带上它；浏览器 half 只需刷新页面。

从 **1.7.x** 升级有专门的迁移流程，安装脚本会自动执行——见 **[docs/UPGRADING.zh.md](./docs/UPGRADING.zh.md)**。

## 卸载

从 `cordis.patch.yml` 删除 `model-request-accelerator` 条目；不想留就顺手删掉克隆的目录。改动实时生效，刷新页面卡片就消失了。

## 更多

- **[docs/CONFIGURATION.zh.md](./docs/CONFIGURATION.zh.md)** —— 每一项设置，以及启用前值得理解的两件事。
- **[docs/TROUBLESHOOTING.zh.md](./docs/TROUBLESHOOTING.zh.md)** —— 症状、原因、该查什么，也包括本插件能力的边界。
- **[docs/UPGRADING.zh.md](./docs/UPGRADING.zh.md)** —— 更新与升级，含 1.7.x 的设置迁移。
- **[docs/INTERNALS.md](./docs/INTERNALS.md)** —— 实现原理与取舍：测量所用的诊断、h2 传输层、预传输池、HTTP/3 与签名请求，以及为什么它不能是动态插件（英文）。
- **[docs/CONTRIBUTING.md](./docs/CONTRIBUTING.md)** —— 测试套件，以及在这里真正发现过 bug 的做法（英文）。
- **[CHANGELOG.md](./CHANGELOG.md)** —— 发布说明。

## 许可

[MIT](./LICENSE)
