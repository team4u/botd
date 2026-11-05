import React from 'react';
import { computeCheckListSelection } from '../check-list-selection.js';

export interface CheckListOption<T> {
  id: string;
  data: T;
}

export interface CheckListProps<T> {
  /** 区块标题，如「启用技能」「参会成员」 */
  label: string;
  options: CheckListOption<T>[];
  selected: string[];
  onChange: (ids: string[]) => void;
  /** 渲染选项内容（不含勾选框），返回的节点置于勾选框右侧 */
  renderItem: (data: T, checked: boolean) => React.ReactNode;
  /** 锁定项：始终保持选中，全选/反选/点击均不会取消（如群聊主持人） */
  lockedIds?: string[];
  /** grid：紧凑小卡（技能/扩展）；list：成员行（默认） */
  variant?: 'grid' | 'list';
  /** 已选计数单位，默认「项」 */
  countUnit?: string;
  /** 标题行下方的说明文字 */
  description?: React.ReactNode;
  /** options 为空时的提示 */
  emptyText?: string;
  /** 勾选框的无障碍标签 */
  getAriaLabel?: (data: T) => string;
}

/**
 * 通用多选勾选列表：标题行内置「全选 / 反选」，支持锁定项与自定义行内容。
 * 全选/反选只作用于当前 options，selected 中不在 options 内的遗留 id 会被保留。
 */
export function CheckList<T>({
  label,
  options,
  selected,
  onChange,
  renderItem,
  lockedIds = [],
  variant = 'list',
  countUnit = '项',
  description,
  emptyText = '暂无可选项',
  getAriaLabel,
}: CheckListProps<T>) {
  const locked = new Set(lockedIds);
  const isSelected = (id: string) => locked.has(id) || selected.includes(id);
  const selectedCount = options.filter((o) => isSelected(o.id)).length;

  const toggle = (id: string) => {
    if (locked.has(id)) return;
    onChange(computeCheckListSelection({ options, selected, lockedIds, action: 'toggle', toggleId: id }));
  };

  const selectAll = () => {
    onChange(computeCheckListSelection({ options, selected, lockedIds, action: 'selectAll' }));
  };

  const invert = () => {
    onChange(computeCheckListSelection({ options, selected, lockedIds, action: 'invert' }));
  };

  const isGrid = variant === 'grid';

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">
          {label}（已选 {selectedCount}/{options.length} {countUnit}）
        </span>
        {options.length > 0 && (
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              type="button"
              onClick={selectAll}
              className="px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md cursor-pointer transition-colors"
            >
              全选
            </button>
            <span className="text-[11px] text-zinc-300 dark:text-zinc-700">|</span>
            <button
              type="button"
              onClick={invert}
              className="px-1.5 py-0.5 text-[11px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-md cursor-pointer transition-colors"
            >
              反选
            </button>
          </div>
        )}
      </div>

      {description && (
        <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mb-2 leading-relaxed">{description}</div>
      )}

      {options.length === 0 ? (
        <p className="text-xs text-zinc-400 dark:text-zinc-500 bg-zinc-50 dark:bg-zinc-900 p-3 rounded-xl border border-zinc-200 dark:border-zinc-800">
          {emptyText}
        </p>
      ) : (
        <div
          className={
            isGrid
              ? 'grid grid-cols-1 sm:grid-cols-2 gap-2 border border-zinc-200 dark:border-zinc-800 rounded-xl p-2.5 bg-zinc-50/50 dark:bg-zinc-900/50 max-h-36 overflow-y-auto'
              : 'space-y-1.5 max-h-52 overflow-y-auto border border-zinc-200 dark:border-zinc-800 rounded-xl p-2 bg-zinc-50/50 dark:bg-zinc-900/50'
          }
        >
          {options.map((opt) => {
            const checked = isSelected(opt.id);
            return (
              <label
                key={opt.id}
                className={`${
                  isGrid
                    ? 'flex items-center gap-2 p-1.5 rounded-lg border text-[11px] cursor-pointer transition-colors'
                    : 'flex items-center gap-2 p-2 rounded-xl border cursor-pointer transition-all'
                } ${
                  checked
                    ? 'bg-indigo-50/70 dark:bg-indigo-950/40 border-indigo-300 dark:border-indigo-800 text-indigo-950 dark:text-indigo-200'
                    : isGrid
                      ? 'bg-white dark:bg-zinc-950 border-zinc-200 dark:border-zinc-800 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800'
                      : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700 text-zinc-700 dark:text-zinc-300'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={locked.has(opt.id)}
                  onChange={() => toggle(opt.id)}
                  aria-label={getAriaLabel?.(opt.data)}
                  className="rounded border-zinc-300 dark:border-zinc-600 dark:bg-zinc-800 text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5 shrink-0 disabled:opacity-60 disabled:cursor-not-allowed"
                />
                {renderItem(opt.data, checked)}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
