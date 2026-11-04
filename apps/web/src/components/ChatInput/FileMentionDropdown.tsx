import React, { useEffect } from 'react';
import { Hash, Loader2, AlertTriangle } from 'lucide-react';

interface FileMentionDropdownProps {
  fileQuery: string;
  fileIndex: number;
  setFileIndex: (index: number) => void;
  filteredFiles: string[];
  loadingFiles: boolean;
  filesError: string | null;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  itemRefs: React.MutableRefObject<(HTMLButtonElement | null)[]>;
  insertFileMention: (filePath: string) => void;
}

/** `#` 工作区文件引用浮层（受控展示，触发与键盘逻辑在 useFileMentionMenu） */
export const FileMentionDropdown: React.FC<FileMentionDropdownProps> = ({
  fileQuery,
  fileIndex,
  setFileIndex,
  filteredFiles,
  loadingFiles,
  filesError,
  dropdownRef,
  itemRefs,
  insertFileMention,
}) => {
  // 高亮项滚动至可见
  useEffect(() => {
    if (filteredFiles.length > 0) {
      itemRefs.current[fileIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [fileIndex, filteredFiles.length, itemRefs]);

  const highlightQuery = (path: string) => {
    // 在文件名与目录两段中分别高亮命中的查询词（大小写不敏感）
    const slash = path.lastIndexOf('/');
    const dir = slash >= 0 ? path.slice(0, slash + 1) : '';
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    const q = fileQuery.trim();
    if (!q) {
      return { dir, pre: '', match: '', post: name };
    }
    const idx = name.toLowerCase().indexOf(q.toLowerCase());
    if (idx >= 0) {
      return {
        dir,
        pre: name.slice(0, idx),
        match: name.slice(idx, idx + q.length),
        post: name.slice(idx + q.length),
      };
    }
    return { dir, pre: '', match: '', post: name };
  };

  return (
    <div
      ref={dropdownRef}
      id="file-mention-listbox"
      className="absolute bottom-full left-3 right-3 sm:left-4 sm:max-w-md mb-2 bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-800 overflow-hidden z-30 max-h-60 max-w-[calc(100vw-1.5rem)] flex flex-col animate-in fade-in slide-in-from-bottom-2"
      role="listbox"
      aria-label="引用工作区文件"
    >
      <div className="px-3 py-1.5 bg-zinc-50 dark:bg-zinc-800/60 border-b border-zinc-100 dark:border-zinc-800 text-[11px] font-medium text-zinc-500 dark:text-zinc-400 flex items-center justify-between shrink-0">
        <span className="flex items-center gap-1">
          <Hash className="w-3 h-3 text-emerald-500 dark:text-emerald-400" />
          <span>引用工作区文件</span>
        </span>
        <span className="text-zinc-400 dark:text-zinc-500 font-normal">
          {loadingFiles ? '加载中...' : filesError ? '加载失败' : `${filteredFiles.length} 个匹配`}
        </span>
      </div>

      <div className="p-1 space-y-0.5 overflow-y-auto">
        {loadingFiles && (
          <div className="px-2.5 py-3 flex items-center justify-center gap-2 text-xs text-zinc-400 dark:text-zinc-500">
            <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />
            <span>正在获取工作区文件...</span>
          </div>
        )}

        {!loadingFiles && filesError && (
          <div className="px-2.5 py-3 flex items-center justify-center gap-2 text-xs text-amber-600 dark:text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>{filesError}</span>
          </div>
        )}

        {!loadingFiles && !filesError && filteredFiles.length === 0 && (
          <div className="px-2.5 py-3 text-center text-xs text-zinc-400 dark:text-zinc-500">
            {fileQuery ? `没有匹配「${fileQuery}」的文件` : '工作区没有可用文件'}
          </div>
        )}

        {!loadingFiles &&
          !filesError &&
          filteredFiles.map((path, index) => {
            const isSelected = index === fileIndex;
            const { dir, pre, match, post } = highlightQuery(path);
            return (
              <button
                key={path}
                id={`file-mention-${index}`}
                type="button"
                onClick={() => insertFileMention(path)}
                onMouseEnter={() => setFileIndex(index)}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                className={`w-full text-left px-2.5 py-1.5 rounded-lg font-mono text-[11px] leading-relaxed transition-colors cursor-pointer truncate ${
                  isSelected
                    ? 'bg-emerald-50 dark:bg-emerald-950/50 text-emerald-900 dark:text-emerald-200'
                    : 'hover:bg-zinc-50 dark:hover:bg-zinc-800 text-zinc-700 dark:text-zinc-300'
                }`}
                role="option"
                aria-selected={isSelected}
              >
                <span className="text-zinc-400 dark:text-zinc-500">{dir}</span>
                <span className="text-zinc-800 dark:text-zinc-100">{pre}</span>
                {match && (
                  <span className="rounded-sm bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300 font-semibold">
                    {match}
                  </span>
                )}
                <span className="text-zinc-800 dark:text-zinc-100">{post}</span>
              </button>
            );
          })}
      </div>

      {!loadingFiles && !filesError && filteredFiles.length > 0 && (
        <div className="px-3 py-1 border-t border-zinc-100 dark:border-zinc-800 text-[10px] text-zinc-400 dark:text-zinc-500 shrink-0">
          ↑↓ 选择 · Enter/Tab 插入 · Esc 关闭
        </div>
      )}
    </div>
  );
};
