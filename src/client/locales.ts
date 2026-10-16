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
  'row.partial': 'Some output could not be shown in full.',
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
  'status.failed': 'Finished after an error',
} as const

/** Simplified Chinese messages. */
export const zh: Record<keyof typeof en, string> = {
  'row.title': '使用 {tool} 运行命令',
  'row.counter': '{done}/{total}',
  'row.elapsed': '{seconds} 秒',
  'row.partial': '部分输出未能完整显示。',
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
  'status.failed': '执行结束但有错误',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'shell-progress': keyof typeof en
  }
}
