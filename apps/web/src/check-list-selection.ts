/**
 * 通用多选勾选列表选项计算（纯函数）：
 * 从 CheckList 组件中拆出以保持 Fast Refresh 兼容（组件文件只导出组件）。
 */
/**
 * 通用多选勾选列表选项计算纯函数：
 * - 反选/全选只影响当前 options；
 * - selected 中不在 options 内的非选项/隐藏 ID 无条件保留；
 * - locked 项始终保留且 toggle 不能取消；
 * - 避免重复 ID，保持合理顺序。
 */
export interface ComputeCheckListSelectionParams {
  options: { id: string }[];
  selected: string[];
  lockedIds?: string[];
  action: 'selectAll' | 'invert' | 'toggle';
  toggleId?: string;
}

export function computeCheckListSelection({
  options,
  selected,
  lockedIds = [],
  action,
  toggleId,
}: ComputeCheckListSelectionParams): string[] {
  const locked = new Set(lockedIds);
  const selectedIds = new Set(selected);
  if (action === 'toggle') {
    const next = !toggleId || locked.has(toggleId)
      ? selected
      : selectedIds.has(toggleId)
        ? selected.filter((id) => id !== toggleId)
        : [...selected, toggleId];
    return [...new Set([...next, ...lockedIds])];
  }

  const optionIds = new Set(options.map((option) => option.id));
  const nextOptions = options
    .filter(({ id }) => action === 'selectAll' || locked.has(id) || !selectedIds.has(id))
    .map(({ id }) => id);
  const hiddenIds = selected.filter((id) => !optionIds.has(id));
  return [...new Set([...nextOptions, ...lockedIds, ...hiddenIds])];
}
