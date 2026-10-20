/**
 * This plugin's own locale namespace.
 *
 * Registering into another package's namespace is not possible from outside
 * the DSH tree, so the row owns `shell-progress` and every product-visible
 * string it renders lives here. English is the required terminal fallback.
 *
 * @module dsh-shell-progress/client/locales
 */

/** This plugin's dictionary namespace. */
export const NS = 'shell-progress'

/** English messages (the terminal fallback). */
export const en = {
  'row.title': 'Run a command with {tool}',
  'row.counter': '{done}/{total}',
  'row.elapsed': '{seconds}s',
  'row.total': 'Total time',
  'row.partial': 'Some output could not be shown in full',
  'row.untracked': 'This command was not split, so the bar covers the whole command.',
  'row.untracked.reason': ' (reason: {reason})',
  'row.reason.block-comment': 'the command contains a block comment',
  'row.reason.here-string': 'the command contains a here-string',
  'row.reason.line-continuation': 'a line ends with a continuation backtick',
  'row.reason.unterminated-quote': 'a quoted string is never closed',
  'row.reason.unbalanced': 'parentheses or braces are unbalanced',
  'row.reason.syntax-error': 'the shell reported a syntax error',
  'row.reason.no-answer': 'the parser could not answer',
  'row.reason.unsplittable': 'the command has a structure that cannot be split safely',
  'row.reason.too-many-steps': 'the command has more steps than the limit',
  'row.reason.already-instrumented': 'the command already contains this plugin\u2019s marker',
  'row.reason.reserved-variable': 'the command already uses the reserved variable',
  'row.reason.read-only': 'the sandbox is read-only',
  /*
   * Says what the CUT cost, at the cut: the per-step output budget discards whole
   * lines, and without this a truncated step is indistinguishable from a quiet one.
   * `chars` counts everything the budget dropped for that step, newlines included —
   * the same units the budget charges, so kept + dropped is the step's real output.
   *
   * ENGLISH IN EVERY LOCALE, and not to be translated: the shell already has a wording for
   * "these bytes did not fit", and it is English whatever the interface language is —
   * `dsh-client-ui-tool`'s `describeOmitted` returns `Omitted ${count} ${unit}.` /
   * `More ${unit} were omitted.` over the units `items | bytes | chars | lines`, while only
   * the row's LABEL is localized (`detail.output.truncated`). A cut in a stream is an
   * annotation about the data, not interface copy, so this note borrows the shell's own
   * sentence and unit name, and reads beside its `[output truncated]` and
   * `[lines: 1-40 of 900]` markers instead of beside a translation of our own. The leading
   * `…` is the "the cut is here" glyph, which has no language.
   */
  'row.truncated': '… Omitted {chars} chars.',
  'row.expand': 'Show steps',
  'row.collapse': 'Hide steps',
  'row.stepLabel': 'Step {index} of {total}, line {line}',
  'row.output': 'Output',
  'row.preamble': 'Output before the first step',
  'row.empty': 'No steps were produced.',
  'hover.copy': 'Copy command line',
  'hover.copied': 'Copied',
  'status.done': 'Done',
  'status.running': 'Running',
  'status.pending': 'Not started',
  /* The DSH Settings section. The label names the PLUGIN, the way the shell names every other
   * section after the feature it configures rather than after one of its rows. */
  'settings.tabLabel': 'Shell Progress',
  'settings.notes': 'Describe each command step',
  'settings.notesDesc': 'Write one short line about each step of a command, shown above that line in the step hover card. (Each command needs one extra model call, and the command text is sent to the model.)',
} as const

/** Simplified Chinese messages. */
export const zh: Record<keyof typeof en, string> = {
  'row.title': '使用 {tool} 运行命令',
  'row.counter': '{done}/{total}',
  'row.elapsed': '{seconds} 秒',
  'row.total': '总用时',
  'row.partial': '部分输出未能完整显示',
  'row.untracked': '这条命令没有被切分，进度只代表整条命令。',
  'row.untracked.reason': '（原因：{reason}）',
  'row.reason.block-comment': '命令里有块注释',
  'row.reason.here-string': '命令里有 here-string',
  'row.reason.line-continuation': '某行以续行反引号结尾',
  'row.reason.unterminated-quote': '有引号没有闭合',
  'row.reason.unbalanced': '括号或花括号不平衡',
  'row.reason.syntax-error': 'shell 报了语法错误',
  'row.reason.no-answer': '解析器没有给出结果',
  'row.reason.unsplittable': '命令结构无法安全切分',
  'row.reason.too-many-steps': '步骤数超过上限',
  'row.reason.already-instrumented': '命令里已经含有本插件的标记',
  'row.reason.reserved-variable': '命令里已经使用了保留变量',
  'row.reason.read-only': '沙箱是只读模式',
  // 英文原样，故意不翻译：见英文键旁的说明。shell 自己的省略措辞就是英文的
  //（`describeOmitted`：`Omitted N chars.`），它本地化的只是行的标签。
  'row.truncated': '… Omitted {chars} chars.',
  'row.expand': '展开步骤',
  'row.collapse': '收起步骤',
  'row.stepLabel': '第 {index} 步，共 {total} 步，第 {line} 行',
  'row.output': '输出',
  'row.preamble': '第一步之前的输出',
  'row.empty': '没有产生步骤。',
  'hover.copy': '复制命令行',
  'hover.copied': '已复制',
  'status.done': '已完成',
  'status.running': '执行中',
  'status.pending': '未开始',
  'settings.tabLabel': '命令进度',
  'settings.notes': '生成命令步骤说明',
  'settings.notesDesc': '为每条命令步骤写一行简短说明，显示在步骤悬停卡片中该行代码的上方。（每条命令需要额外一次模型调用，命令文本会发送给模型）',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'shell-progress': keyof typeof en
  }
}
