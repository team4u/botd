import React from 'react';
import type { BotConfig, NodeWithBots } from '@botd/protocol';
import { SkillEditorModal } from '../SkillEditorModal';
import { ExtensionEditorModal } from '../ExtensionEditorModal';
import { BotEditorModal } from '../BotEditorModal';

interface EditorModalsProps {
  skill: {
    open: boolean;
    node: { id: string; name: string } | null;
    skillId: string | null;
    setOpen: (open: boolean) => void;
  };
  extension: {
    open: boolean;
    node: { id: string; name: string } | null;
    extId: string | null;
    setOpen: (open: boolean) => void;
  };
  bot: {
    open: boolean;
    node: NodeWithBots | null;
    selected: BotConfig | null;
    parentBot: BotConfig | null;
    initialTab: 'basic' | 'system' | 'memory';
    setOpen: (open: boolean) => void;
    clearParent: () => void;
  };
  onSaved: (toast: string) => Promise<void>;
}

/** 技能/扩展/智能体三个编辑器弹窗：由 NodesBotsView 的入口回调统一打开。 */
export const EditorModals: React.FC<EditorModalsProps> = ({ skill, extension, bot, onSaved }) => (
  <>
    {skill.node && (
      <SkillEditorModal
        isOpen={skill.open}
        nodeId={skill.node.id}
        nodeName={skill.node.name}
        skillId={skill.skillId}
        onClose={() => skill.setOpen(false)}
        onSaved={async () => {
          await onSaved('技能说明文档保存成功');
        }}
      />
    )}

    {extension.node && (
      <ExtensionEditorModal
        isOpen={extension.open}
        nodeId={extension.node.id}
        nodeName={extension.node.name}
        extId={extension.extId}
        onClose={() => extension.setOpen(false)}
        onSaved={async () => {
          await onSaved(extension.extId ? '扩展已更新' : '扩展已成功保存');
        }}
      />
    )}

    <BotEditorModal
      isOpen={bot.open}
      node={bot.node}
      bot={bot.selected}
      parentBot={bot.parentBot}
      initialTab={bot.initialTab}
      onClose={() => {
        bot.setOpen(false);
        bot.clearParent();
      }}
      onSaved={async () => {
        await onSaved(
          bot.selected
            ? bot.selected.parentBotId
              ? '子代理配置已成功更新'
              : '智能体配置已成功更新'
            : bot.parentBot
            ? '新子代理创建成功'
            : '新智能体创建成功'
        );
      }}
    />
  </>
);
