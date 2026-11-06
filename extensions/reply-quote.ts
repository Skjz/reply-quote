/**
 * reply-quote —— 鼠标选中文字 → 引用回复
 *
 * 工作流：
 *   1. 用鼠标拖选要引用的文字（句、段都行，选多大由你决定）
 *   2. 按 ⌃⇧R（ctrl+shift+r）→ 选中的文字以编号引用块追加到输入框，光标停在"回复："后面
 *      （同时注册了 ⌃R / ctrl+r 作为兼容键：终端未启用 kitty keyboard protocol 时
 *        ⌃⇧R 会被降级成 ctrl+r 的原始字节，两个绑定指向同一个处理函数）
 *   3. 直接输入回复，Enter 发送
 *   4. 多条引用：重复 1-2，编号自动递增
 *
 * 内容来源（已验证，2026-11）：
 * - tuiMode=regular：选区由终端原生处理，pi 的 TUI 看不到选区
 *   （TuiMainScreen 无选区 API），依赖终端"选中即复制"把文本放进剪贴板，
 *   所以实际走剪贴板路径。要求终端开启选中自动复制（otty 默认开启）。
 * - tuiMode=fullscreen：优先直读 TuiAltScreen 的选区（hasActiveSelection/
 *   getActiveSelectionText），失败时再回退剪贴板（fullscreen 选区在松开鼠标时
 *   也会自动复制到剪贴板）。
 * 两条路径都不弹确认框——按快捷键本身即已表明引用意图，插错了可以 ⌃Z 撤销。
 *
 * 注意：不要使用 Option 组合键——macOS 终端默认会把 Option+字母合成特殊字符
 *（如 Option+Shift+R → ‰），除非用户在终端里开启了 "Option as Alt"。
 *
 * 调试：设置环境变量 REPLY_QUOTE_DEBUG=1 后，每次触发会追加写入
 * ~/.pi/agent/debug_reply_quote.log（记录走的是选区直读还是剪贴板路径）。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";

/** 调试日志（REPLY_QUOTE_DEBUG=1 时启用）：记录快捷键触发时走了哪条路径 */
const DEBUG_LOG = `${homedir()}/.pi/agent/debug_reply_quote.log`;
function debug(msg: string): void {
  if (!process.env.REPLY_QUOTE_DEBUG) return;
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // 日志失败不影响主流程
  }
}

const WIDGET_KEY = "reply-quote-capture";
const HEADER = "回复以下引用：";
const BLOCK_RE = /^(\d+)\.\s*引用：/gm;

/** TuiAltScreen 上与文本选区相关的方法（部分为运行时私有，做鸭子类型访问） */
type SelectionTui = {
  hasActiveSelection?: () => boolean;
  getActiveSelectionText?: () => string | undefined;
  resetTextSelection?: () => void;
};

// 零高度组件：仅用于借 setWidget 的 factory 拿到实时 TUI 引用
const captureComponent = {
  render: (_width: number): string[] => [],
  invalidate: (): void => {},
};

/** 通过零高度 widget 捕获当前 TUI 实例（调用后立即移除，界面无变化） */
function captureTui(ctx: ExtensionContext): SelectionTui | undefined {
  if (!ctx.hasUI) return undefined;
  let tui: SelectionTui | undefined;
  try {
    ctx.ui.setWidget(
      WIDGET_KEY,
      (t) => {
        tui = t as unknown as SelectionTui;
        return captureComponent;
      },
      { placement: "aboveEditor" },
    );
    ctx.ui.setWidget(WIDGET_KEY, undefined);
  } catch {
    return undefined;
  }
  return tui;
}

/** 跨平台读取剪贴板，失败返回 undefined */
function readClipboard(): string | undefined {
  const attempts: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["pbpaste", []]]
      : process.platform === "win32"
        ? [["powershell", ["-NoProfile", "-Command", "Get-Clipboard"]]]
        : [
            ["wl-paste", ["--no-newline"]],
            ["xclip", ["-selection", "clipboard", "-o"]],
            ["xsel", ["--clipboard", "--output"]],
          ];
  for (const [cmd, args] of attempts) {
    try {
      return execFileSync(cmd, args, { timeout: 2000, encoding: "utf8" }).replace(/\n$/, "");
    } catch {
      // 尝试下一个命令
    }
  }
  return undefined;
}

/** 根据输入框里已有的 "N. 引用：" 行推算下一个编号 */
function nextQuoteNumber(editorText: string): number {
  let max = 0;
  BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_RE.exec(editorText)) !== null) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

/** 把引用文本包装成编号引用块 */
function buildQuoteBlock(quote: string, num: number): string {
  const lines = quote.replace(/\s+$/, "").split("\n");
  const quoted = lines.map((l) => `   > ${l}`).join("\n");
  return `${num}. 引用：\n${quoted}\n   回复：`;
}

// 防止快速连按造成 setEditorText 竞态
let busy = false;

function handleQuote(ctx: ExtensionContext): void {
  if (!ctx.hasUI || busy) return;
  busy = true;
  try {
    // 1. 优先读鼠标选区（fullscreen 下选区在松开鼠标后仍然有效，按键不会清除它）
    const tui = captureTui(ctx);
    let quote: string | undefined;
    let usedSelection = false;
    let selectionNote = "captureTui 未拿到 TUI";
    if (tui) {
      const hasFn = typeof tui.hasActiveSelection === "function";
      const getFn = typeof tui.getActiveSelectionText === "function";
      if (!hasFn || !getFn) {
        selectionNote = `方法缺失 has=${hasFn} get=${getFn}（regular 模式预期行为，走剪贴板）`;
      } else {
        try {
          const active = tui.hasActiveSelection();
          if (active) {
            quote = tui.getActiveSelectionText();
            usedSelection = true;
            selectionNote = `hasActiveSelection=true text=${quote !== undefined}`;
          } else {
            selectionNote = "hasActiveSelection=false";
          }
        } catch (err) {
          selectionNote = `hasActiveSelection 抛错: ${String(err)}`;
        }
      }
    }

    // 2. 回退：直接读剪贴板（regular 模式：终端原生选区自动复制；
    //    fullscreen 模式：TuiAltScreen 在松开鼠标时自动复制）。
    //    不弹确认框——按快捷键即已表明引用意图，插错可 ⌃Z 撤销。
    let usedClipboard = false;
    if (!quote || !quote.trim()) {
      const fromClipboard = readClipboard();
      if (fromClipboard && fromClipboard.trim()) {
        quote = fromClipboard.trim();
        usedClipboard = true;
      }
    }

    debug(
      `selection: ${selectionNote} | usedSelection=${usedSelection} usedClipboard=${usedClipboard} quote=${JSON.stringify((quote ?? "").slice(0, 60))} editorBefore=${ctx.ui.getEditorText().length}`,
    );

    if (!quote || !quote.trim()) {
      ctx.ui.notify(
        "没有可引用的内容：先用鼠标拖选文字再按 ⌃⇧R，或先把文字复制到剪贴板",
        "warning",
      );
      return;
    }

    // 3. 追加编号引用块到输入框；setEditorText 后光标在末尾（"回复："之后）
    const base = ctx.ui.getEditorText().trimEnd();
    const block = buildQuoteBlock(quote, nextQuoteNumber(base));
    ctx.ui.setEditorText(base ? `${base}\n\n${block}` : `${HEADER}\n\n${block}`);

    // 4. 清掉选区高亮（仅 fullscreen 路径需要）
    if (usedSelection) {
      tui?.resetTextSelection?.();
    }
  } finally {
    busy = false;
  }
}

export default function (pi: ExtensionAPI): void {
  // ⌃⇧R：kitty keyboard protocol 下精确匹配（otty/iTerm2/VS Code 等现代终端）
  pi.registerShortcut("ctrl+shift+r", {
    description: "把鼠标选中的文字插入输入框，作为引用回复（可重复，多条自动编号）",
    handler: (ctx) => handleQuote(ctx),
  });
  // ⌃R：兼容键。旧式终端里 ⌃⇧R 发的是和 ⌃R 相同的原始字节（0x12），
  // 会被解析为 ctrl+r；kitty 协议下两者修饰符不同、各自精确匹配，不会互相干扰。
  pi.registerShortcut("ctrl+r", {
    description: "引用回复（ctrl+shift+r 的兼容键，旧式终端下生效）",
    handler: (ctx) => handleQuote(ctx),
  });

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      // 底部状态栏提示，方便想起这个快捷键
      ctx.ui.setStatus("reply-quote", "⌃⇧R 引用");
    }
  });
}
