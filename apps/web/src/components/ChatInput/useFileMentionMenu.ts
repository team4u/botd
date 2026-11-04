import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BotConfig } from '@botd/protocol';

/**
 * # 工作区文件模糊补全：纯过滤排序函数（导出以便单元测试）。
 * 匹配策略按优先级分层，同层内按路径长度升序（短路径更可能是目标）：
 * 1. 文件名精确 / 前缀匹配；
 * 2. 文件名首字母驼峰 / 分隔符缩写匹配（mt → MessageTimeline.tsx，ci → ChatInput.tsx）；
 * 3. 路径子串包含匹配；
 * 4. 字符顺序子序列 fuzzy 匹配。
 */

/** 取不含扩展名的文件名（最后一段路径去掉首个扩展名） */
function baseName(filePath: string): string {
  const fileName = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = fileName.indexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/** 归一化：小写并按驼峰/分隔符切成词块，用于缩写与子串匹配 */
function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
}

/** 字符顺序子序列匹配：q 的每个字符按顺序出现在 target 中 */
function isSubsequence(query: string, target: string): boolean {
  let i = 0;
  for (let j = 0; i < query.length && j < target.length; j++) {
    if (query[i] === target[j]) i++;
  }
  return i === query.length;
}

interface ScoredMatch {
  path: string;
  tier: number;
}

/**
 * 对候选文件列表按查询词过滤并打分。
 * 返回按 (tier, 路径长度, 路径字典序) 排序的路径列表，最多 limit 条。
 */
export function filterWorkspaceFiles(files: string[], rawQuery: string, limit = 12): string[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) {
    return [...files].sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, limit);
  }

  const scored: ScoredMatch[] = [];
  for (const path of files) {
    if (!path) continue;
    const lowerPath = path.toLowerCase();
    const name = baseName(path).toLowerCase();

    let tier: number | null = null;
    // 1. 文件名精确 / 前缀
    if (name === query || name.startsWith(query)) {
      tier = 0;
    } else {
      // 2. 文件名词块缩写（首字母序列）或词块前缀序列（驼峰/分隔符切分需保留原始大小写）
      const tokens = tokenize(baseName(path));
      const initials = tokens.map((t) => t[0].toLowerCase()).join('');
      const tokenPrefixes = tokens.map((t) => t.slice(0, Math.min(t.length, query.length)).toLowerCase()).join('');
      if (initials === query || initials.startsWith(query) || tokenPrefixes.startsWith(query) || isSubsequence(query, initials)) {
        tier = 1;
      } else if (lowerPath.includes(query)) {
        // 3. 路径子串包含
        tier = 2;
      } else if (isSubsequence(query, lowerPath)) {
        // 4. 子序列 fuzzy
        tier = 3;
      }
    }

    if (tier !== null) {
      scored.push({ path, tier });
    }
  }

  return scored
    .sort((a, b) => a.tier - b.tier || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((m) => m.path);
}

interface UseFileMentionMenuParams {
  /** 当前输入框草稿（用于补全插入） */
  content: string;
  setContent: React.Dispatch<React.SetStateAction<string>>;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  /** 主导 BOT（决定工作区归属：nodeId + botId） */
  leadBot?: BotConfig;
  sessionId?: string;
}

/**
 * # 文件引用浮层：触发检测、工作区文件列表拉取（带缓存与防竞态）、键盘导航与内联代码插入。
 */
export function useFileMentionMenu({
  content,
  setContent,
  textareaRef,
  leadBot,
  sessionId,
}: UseFileMentionMenuParams) {
  const [showFileMenu, setShowFileMenu] = useState(false);
  const [fileQuery, setFileQuery] = useState('');
  const [fileIndex, setFileIndex] = useState(0);
  const [filePosition, setFilePosition] = useState<{ start: number; end: number }>({
    start: 0,
    end: 0,
  });
  const [files, setFiles] = useState<string[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  const fileDropdownRef = useRef<HTMLDivElement>(null);
  const fileItemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // 已拉取文件列表的缓存键与数据：同一 (nodeId, botId, sessionId) 只拉一次
  const filesCacheKeyRef = useRef<string | null>(null);
  const fetchedKeysRef = useRef<Set<string>>(new Set());
  const fetchRequestIdRef = useRef<number>(0);

  const filteredFiles = useMemo(() => filterWorkspaceFiles(files, fileQuery, 12), [files, fileQuery]);

  // 拉取工作区文件列表（浮层首次针对当前缓存键打开时触发；成功后缓存，失败不缓存以便重试）
  const fetchFiles = useCallback(async (nodeId: string, botId: string, sid: string) => {
    const cacheKey = `${nodeId}|${botId}|${sid}`;
    if (filesCacheKeyRef.current === cacheKey && fetchedKeysRef.current.has(cacheKey)) return;

    const reqId = ++fetchRequestIdRef.current;
    filesCacheKeyRef.current = cacheKey;
    setLoadingFiles(true);
    setFilesError(null);

    try {
      const res = await fetch(
        `/api/nodes/${encodeURIComponent(nodeId)}/bots/${encodeURIComponent(botId)}/files?sessionId=${encodeURIComponent(sid)}`,
        { credentials: 'include' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error || `获取工作区文件失败 (HTTP ${res.status})`);
      }
      const data = (await res.json()) as { files?: string[] };
      if (fetchRequestIdRef.current !== reqId) return;
      setFiles(Array.isArray(data.files) ? data.files : []);
      fetchedKeysRef.current.add(cacheKey);
    } catch (err: any) {
      if (fetchRequestIdRef.current !== reqId) return;
      setFiles([]);
      setFilesError(err?.message || '获取工作区文件失败');
    } finally {
      if (fetchRequestIdRef.current === reqId) {
        setLoadingFiles(false);
      }
    }
  }, []);

  const closeFileMenu = useCallback(() => setShowFileMenu(false), []);

  // 插入选中的文件路径：`#query` → `` `relative/path` ``（带尾随空格），光标移到后面
  const insertFileMention = useCallback((filePath: string) => {
    const el = textareaRef.current;
    if (!el) return;

    const before = content.slice(0, filePosition.start);
    const after = content.slice(filePosition.end);
    const replacement = `\`${filePath}\` `;
    const newContent = `${before}${replacement}${after}`;

    setContent(newContent);
    setShowFileMenu(false);

    const newCursor = filePosition.start + replacement.length;
    setTimeout(() => {
      el.focus();
      el.setSelectionRange(newCursor, newCursor);
    }, 10);
  }, [content, filePosition, setContent, textareaRef]);

  /**
   * # 触发检测：光标前文本命中 `(?:^|\s)#([^\s#]*)$` 时开启浮层（需有 leadBot），否则关闭。
   */
  const checkFileTrigger = useCallback(
    (text: string, cursor: number) => {
      const textBefore = text.slice(0, cursor);
      const match = /(?:^|\s)#([^\s#]*)$/.exec(textBefore);
      if (!match || !leadBot) {
        setShowFileMenu(false);
        return;
      }

      const start = match.index + (match[0].startsWith('#') ? 0 : 1);
      setFileQuery(match[1]);
      setFilePosition({ start, end: cursor });
      setFileIndex(0);
      setShowFileMenu(true);

      void fetchFiles(leadBot.nodeId, leadBot.id, sessionId || '');
    },
    [leadBot, sessionId, fetchFiles],
  );

  /**
   * 浮层打开时的键盘处理。返回 true 表示事件已消费。
   */
  const handleFileKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!showFileMenu) return false;

      if (e.key === 'Escape') {
        e.preventDefault();
        setShowFileMenu(false);
        return true;
      }

      if (loadingFiles || filesError) {
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          return true;
        }
        return false;
      }

      if (filteredFiles.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setFileIndex((prev) => (prev + 1) % filteredFiles.length);
          return true;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setFileIndex((prev) => (prev - 1 + filteredFiles.length) % filteredFiles.length);
          return true;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          const selected = filteredFiles[fileIndex];
          if (selected) {
            insertFileMention(selected);
          }
          return true;
        }
        return false;
      }

      // 无匹配结果时禁止 Enter 意外提交
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        return true;
      }
      return false;
    },
    [showFileMenu, loadingFiles, filesError, filteredFiles, fileIndex, insertFileMention],
  );

  // 查询词变化时重置高亮项
  useEffect(() => {
    setFileIndex(0);
  }, [fileQuery]);

  // 高亮项滚动至可见
  useEffect(() => {
    if (showFileMenu && filteredFiles.length > 0) {
      fileItemRefs.current[fileIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [fileIndex, showFileMenu, filteredFiles.length]);

  // 切换会话时重置状态与缓存
  const resetOnSessionChange = useCallback(() => {
    fetchRequestIdRef.current++;
    filesCacheKeyRef.current = null;
    fetchedKeysRef.current = new Set();
    setFiles([]);
    setFilesError(null);
    setLoadingFiles(false);
    setShowFileMenu(false);
  }, []);

  return {
    // state
    showFileMenu,
    fileQuery,
    fileIndex,
    setFileIndex,
    filteredFiles,
    loadingFiles,
    filesError,
    // refs
    fileDropdownRef,
    fileItemRefs,
    // actions
    insertFileMention,
    checkFileTrigger,
    handleFileKeyDown,
    closeFileMenu,
    resetOnSessionChange,
  };
}
