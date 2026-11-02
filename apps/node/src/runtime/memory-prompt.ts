import type { BotConfig } from '@botd/protocol';

/**
 * 长期记忆提示词组装：集中封装记忆读取结果的 System Prompt 段落构造，
 * 供 execute-turn / subagent-control 复用；全部为纯函数，便于单元测试。
 */

/** MEMORY.md 索引内联展示的最大行数（超出部分引导用 read 工具按需查阅） */
export const MEMORY_INDEX_MAX_LINES = 150;

/**
 * 截断记忆索引内容：超过 maxLines 行时只保留前 maxLines 行并标记 truncated。
 * 返回的 totalLines 始终是原始内容的总行数。
 */
export function truncateMemoryIndex(
  content: string,
  maxLines: number = MEMORY_INDEX_MAX_LINES,
): { text: string; truncated: boolean; totalLines: number } {
  const lines = content.length === 0 ? [] : content.split('\n');
  const totalLines = lines.length;
  if (totalLines <= maxLines) {
    return { text: content, truncated: false, totalLines };
  }
  return { text: lines.slice(0, maxLines).join('\n'), truncated: true, totalLines };
}

/**
 * 判断 Bot 是否具备写长期记忆的能力：
 * - readonly：无写权限；
 * - custom：customTools 须包含 edit / write / bash 之一（bash 也可写文件）；
 * - 其余（all / 未配置）：有写权限。
 */
export function canBotWriteMemory(bot: Pick<BotConfig, 'toolScope' | 'customTools'>): boolean {
  if (bot.toolScope === 'readonly') return false;
  if (bot.toolScope === 'custom') {
    const tools = bot.customTools ?? [];
    return tools.includes('edit') || tools.includes('write') || tools.includes('bash');
  }
  return true;
}

export interface MemoryPromptInput {
  /** 当前 Bot 自身的 MEMORY.md 内容 */
  memoryMd: string;
  /** 子代理场景：所属主 Bot 的 MEMORY.md（子代理 workspace 挂在主 Bot 目录下，../MEMORY.md 即主 Bot 记忆） */
  parentMemoryMd?: string;
  /** 节点级共享记忆 ~/.botd/MEMORY.md */
  nodeMemoryMd?: string;
  /** 已归档的主题记忆文件列表（memory/*.md 文件名） */
  memoryTopics?: string[];
  /** 是否具备写入记忆的能力（canBotWriteMemory 的结果） */
  canWrite: boolean;
}

/**
 * 构造长期记忆提示词段落（单段字符串，由调用方决定是否注入 appendSystemPrompt）。
 * 层次：节点共享记忆 → Bot 长期记忆索引（含截断提示）→ 主题记忆目录索引 → 读写说明。
 */
export function buildMemoryPromptSection(input: MemoryPromptInput): string {
  const { memoryMd, parentMemoryMd, nodeMemoryMd, memoryTopics, canWrite } = input;
  const sections: string[] = [];

  // 1. 节点级共享记忆（全节点 Bot 可读，路径相对 workspace 为 ../../MEMORY.md）
  if (nodeMemoryMd?.trim()) {
    sections.push(`[节点共享记忆 (../../MEMORY.md)]\n${nodeMemoryMd.trim()}`);
  }

  // 2. Bot 长期记忆：子代理合并主 Bot 记忆（主 Bot 在前，子代理专属在后）
  let combinedMemory = memoryMd;
  if (parentMemoryMd?.trim()) {
    if (memoryMd.trim() && memoryMd.trim() !== parentMemoryMd.trim()) {
      combinedMemory = `${parentMemoryMd.trim()}\n\n${memoryMd}`;
    } else if (!memoryMd.trim()) {
      combinedMemory = parentMemoryMd;
    }
  }

  const truncated = truncateMemoryIndex(combinedMemory);
  const title = canWrite
    ? '[长期记忆 (可通过 ../MEMORY.md 与 ../memory/*.md 更新)]'
    : '[长期记忆 (只读)]';
  let memorySection = `${title}\n${truncated.text}`;
  if (truncated.truncated) {
    memorySection += `\n（⚠️ MEMORY.md 共 ${truncated.totalLines} 行，此处仅内联展示前 ${MEMORY_INDEX_MAX_LINES} 行索引；如需完整内容请使用 read 工具读取 \`../MEMORY.md\`，建议将详细专题拆分归档至 \`../memory/<topic>.md\`。）`;
  }
  sections.push(memorySection);

  // 3. 主题记忆目录索引（Progressive Disclosure：正文不内联，按需 read/grep）
  if (memoryTopics && memoryTopics.length > 0) {
    sections.push(
      `[已归档主题记忆目录 (按需通过 read/grep 查阅 ../memory/<文件名>)]\n${memoryTopics
        .map((t) => `- ../memory/${t}`)
        .join('\n')}`,
    );
  }

  // 4. 读写说明与维护规范
  if (!canWrite) {
    // 只读模式：不输出任何 edit/write 写入引导
    return sections.join('\n\n');
  }

  sections.push(
    [
      '（记忆维护规范：）',
      '- 可使用 edit/write 工具修改 `../MEMORY.md`（核心索引，建议保持在 150 行以内），或在 `../memory/<topic>.md` 下按主题创建/更新详细记忆文件。',
      '- 主动沉淀：发现宿主环境关键事实、用户偏好/纠正、项目架构与协作约定时及时更新；按章节归类并原地覆写过时信息，避免追加流水账；严禁写入密钥明文或单次临时任务状态。',
      '- 当用户要求你学习某个本机 CLI 工具并保存为 Skill 时，可执行 `<cli> --help` 并将总结写入 `../../../skills/<skillId>/SKILL.md`。',
    ].join('\n'),
  );

  return sections.join('\n\n');
}
