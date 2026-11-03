import React from 'react';
import { ConfirmDialog } from '../ConfirmDialog';
import type { BotConfig, NodeWithBots } from '@botd/protocol';

/** 删除智能体确认框 */
export const DeleteBotDialog: React.FC<{
  botToDelete: BotConfig | null;
  deletingBotId: string | null;
  onConfirm: () => void;
  onClose: () => void;
}> = ({ botToDelete, deletingBotId, onConfirm, onClose }) => (
  <ConfirmDialog
    isOpen={botToDelete !== null}
    title="删除智能体"
    danger
    busy={deletingBotId !== null}
    confirmText="删除"
    confirmDisabled={deletingBotId !== null}
    onConfirm={onConfirm}
    onClose={onClose}
    message={
      botToDelete ? (
        <>
          确定要从所属计算节点中删除智能体「{botToDelete.name}」（<span className="font-mono">@{botToDelete.id}</span>）吗？
          <br />
          该操作不可逆，删除后无法恢复。
        </>
      ) : null
    }
  />
);

/** 移除计算节点确认框（含仍有智能体时的强制移除二次确认分支） */
export const RemoveNodeDialog: React.FC<{
  nodeToRemove: NodeWithBots | null;
  forceRemoveMode: boolean;
  deletingNodeId: string | null;
  setForceRemoveMode: (force: boolean) => void;
  onConfirm: () => void;
  onClose: () => void;
}> = ({ nodeToRemove, forceRemoveMode, deletingNodeId, setForceRemoveMode, onConfirm, onClose }) => (
  <ConfirmDialog
    isOpen={nodeToRemove !== null}
    title={forceRemoveMode ? '强制移除节点' : '移除计算节点'}
    danger
    busy={deletingNodeId !== null}
    confirmText={forceRemoveMode ? '强制移除' : '移除节点'}
    confirmDisabled={deletingNodeId !== null}
    onConfirm={onConfirm}
    onClose={onClose}
    message={
      nodeToRemove ? (
        (nodeToRemove.bots?.length || 0) > 0 && !forceRemoveMode ? (
          <>
            节点「{nodeToRemove.name}」下仍有 <strong>{nodeToRemove.bots?.length}</strong> 个智能体，需要先删除它们才能移除节点。
            <br />
            若该节点已永久下线（机器报废、无法重启），可选择强制移除：将丢弃这些智能体在本平台的全部记录（节点上的本地数据随机器一起丢失，凭证已吊销不会重新接入）。
            <div className="mt-3 flex flex-col sm:flex-row gap-2">
              <button
                type="button"
                onClick={() => setForceRemoveMode(true)}
                disabled={deletingNodeId !== null}
                className="px-3 py-1.5 text-xs font-medium text-rose-700 hover:text-white hover:bg-rose-600 dark:text-rose-300 dark:hover:bg-rose-600 dark:hover:text-white border border-rose-300 dark:border-rose-800 rounded-lg transition-colors disabled:opacity-50 cursor-pointer"
              >
                我已了解风险，强制移除
              </button>
            </div>
          </>
        ) : forceRemoveMode ? (
          <>
            确定要强制移除节点「{nodeToRemove.name}」及其上 <strong>{nodeToRemove.bots?.length || 0}</strong> 个智能体的平台记录吗？
            <br />
            该操作不可逆：会立即吊销节点凭证并清除 {nodeToRemove.bots?.length || 0} 个智能体的配置缓存；若节点实际仍在线，会尽力同步删除其本地数据。
          </>
        ) : (
          <>
            确定要移除节点「{nodeToRemove.name}」吗？
            <br />
            {nodeToRemove.status === 'online'
              ? '该节点当前在线，移除后将立即断开其连接。'
              : '该节点当前离线。'}
            移除后如需重新接入，需重新执行配对流程。
          </>
        )
      ) : null
    }
  />
);

/** 重启节点确认框 */
export const RestartNodeDialog: React.FC<{
  nodeToRestart: NodeWithBots | null;
  onConfirm: () => void;
  onClose: () => void;
}> = ({ nodeToRestart, onConfirm, onClose }) => (
  <ConfirmDialog
    isOpen={nodeToRestart !== null}
    title="重启节点"
    confirmText="重启"
    confirmDisabled={false}
    onConfirm={onConfirm}
    onClose={onClose}
    message={
      nodeToRestart ? (
        <>
          确定要重启计算节点「{nodeToRestart.name}」吗？
          <br />
          重启期间节点会短暂离线，随后自动恢复连接。
        </>
      ) : null
    }
  />
);
