# reply-quote

Pi 扩展：鼠标选中 agent 消息里的任意文字，按一个快捷键，引用块就出现在输入框里，光标停在"回复："后面——直接打字回复，不用复制粘贴。

## 工作流

1. 用鼠标拖选要引用的文字（句、段都行，粒度自己定）
2. 按 **⌃⇧R**（兼容键 **⌃R**）→ 选中的文字以编号引用块追加到输入框，光标停在"回复："后面
3. 直接输入回复，Enter 发送
4. 多条引用：重复 1-2，编号自动递增

一次 ⌃⇧R 插入的引用块长这样（多条时自动编号）：

```text
回复以下引用：

1. 引用：
   > 选中的第一句
   回复：
```

## 安装

```bash
# git 源（推荐，始终最新）
pi install git:github.com/Skjz/reply-quote

# 或本地路径
pi install /path/to/reply-quote
```

安装后输入 `/reload`（或重启 pi）生效。底部状态栏会出现 `⌃⇧R 引用` 提示。

## 依赖的终端行为

本扩展按 `tuiMode` 分两种取词路径：

| 模式 | 取词方式 | 前提 |
|---|---|---|
| `fullscreen`（pi 默认） | 优先直读 TUI 选区，失败回退剪贴板 | 无（fullscreen 选区在松开鼠标时自动复制到剪贴板） |
| `regular` | 剪贴板 | 终端开启"选中即复制"（otty 默认开启） |

不弹任何确认框——按快捷键本身即已表明引用意图；插错了按 **⌃Z** 整体撤销。

## 调试

设置环境变量后重启 pi：

```bash
export REPLY_QUOTE_DEBUG=1
```

每次触发会追加写入 `~/.pi/agent/debug_reply_quote.log`，记录走的是选区直读还是剪贴板路径、选区 API 的返回情况。

## 自定义

`extensions/reply-quote.ts` 顶部的常量可直接改：

- `HEADER`——引用块组开头的标题行（默认 `回复以下引用：`）
- `buildQuoteBlock`——引用块模板（`N. 引用：` / `> ` 前缀 / `回复：`）
- `registerShortcut(...)` 调用——快捷键

## 许可证

MIT
