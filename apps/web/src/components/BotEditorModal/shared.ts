import type { BotConfig, SubagentColor } from '@botd/protocol';

export interface ResolveBotEditorOpenStepParams {
  isOpen: boolean;
  wasOpen?: boolean;
  bot?: BotConfig | null;
  parentBot?: BotConfig | null;
}

export function resolveBotEditorOpenStep(params: ResolveBotEditorOpenStepParams) {
  const isSubagent = Boolean(params.bot?.parentBotId || params.parentBot?.id);
  const parentBotId = params.bot?.parentBotId || params.parentBot?.id;
  return {
    isSubagent,
    parentBotId,
  };
}

export const SUBAGENT_COLOR_OPTIONS: { id: SubagentColor; label: string; bg: string }[] = [
  { id: 'blue', label: '蓝色', bg: 'bg-blue-500' },
  { id: 'purple', label: '紫色', bg: 'bg-purple-500' },
  { id: 'red', label: '红色', bg: 'bg-red-500' },
  { id: 'emerald', label: '翡翠绿', bg: 'bg-emerald-500' },
  { id: 'amber', label: '琥珀橙', bg: 'bg-amber-500' },
  { id: 'cyan', label: '青色', bg: 'bg-cyan-500' },
  { id: 'pink', label: '粉色', bg: 'bg-pink-500' },
  { id: 'indigo', label: '靛蓝', bg: 'bg-indigo-500' },
];

export const DEFAULT_SYSTEM_MD = `# 角色定位
你是一个专业、严谨且遵循 UNIX 哲学的 AI 智能助手。

## 协作规范
1. 在群聊中通过 @<botId> 呼叫其他成员协同，不输出冗余客套话。
2. 遇到需要执行系统操作或外部工具时，善用所属 Node 提供的本地命令与已启用的技能。
3. 结论清晰、要点明确。
`;

export const DEFAULT_MEMORY_MD = `## 核心背景与偏好记忆
- 用户环境：多节点协作系统
- 约定：公屏输出结构化结论，保持严谨简洁
`;

/**
 * 记忆保存 Dirty Check：
 * - 新建 Bot：仅当用户填了非空记忆时才额外发 PUT（后端 saveBot 已默认建空 MEMORY.md）；
 * - 编辑 Bot：仅当用户实际改动记忆内容时才保存，避免旧快照冲掉后台新写入的记忆。
 */
export function shouldSaveBotMemory(
  isEditing: boolean,
  memoryMd: string,
  initialMemoryMd: string | null,
): boolean {
  if (!isEditing) {
    return memoryMd.trim().length > 0;
  }
  return initialMemoryMd !== null && memoryMd !== initialMemoryMd;
}
