import React, { useEffect, useRef, useState } from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';

type Mermaid = (typeof import('mermaid'))['default'];

/** mermaid 懒加载单例：首次渲染图表时才拉取体积较大的 chunk */
let mermaidPromise: Promise<Mermaid> | null = null;
const loadMermaid = (): Promise<Mermaid> => {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => mod.default);
  }
  return mermaidPromise;
};

/** 全局自增序号，保证每次 render 调用的容器 id 唯一 */
let renderSeq = 0;
const isDarkTheme = () => document.documentElement.classList.contains('dark');

interface MermaidBlockProps {
  chart: string;
}

/**
 * Mermaid 图表渲染块：
 * - 懒加载 mermaid，避免拖累首屏
 * - 跟随系统主题（html.dark）自动切换 default/dark 主题重绘
 * - 渲染失败时降级展示源码，不阻断消息阅读
 * - 流式输出场景下对半成品语法做 debounce
 */
export const MermaidBlock: React.FC<MermaidBlockProps> = ({ chart }) => {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lastDarkRef = useRef<boolean>(isDarkTheme());

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const doRender = async () => {
      try {
        const mermaid = await loadMermaid();
        if (cancelled) return;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: isDarkTheme() ? 'dark' : 'default',
          fontFamily: 'inherit',
        });
        const id = `botd-mermaid-${++renderSeq}`;
        const { svg: rendered } = await mermaid.render(id, chart);
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    };

    // 流式输出时内容会高频变化，debounce 避免半成品语法反复触发渲染
    timer = setTimeout(doRender, 250);

    // 系统主题切换（html.dark 变化）时用对应主题重绘
    const observer = new MutationObserver(() => {
      const dark = isDarkTheme();
      if (dark !== lastDarkRef.current) {
        lastDarkRef.current = dark;
        if (timer) clearTimeout(timer);
        timer = setTimeout(doRender, 0);
      }
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      observer.disconnect();
    };
  }, [chart]);

  if (error) {
    return (
      <div className="my-3 not-prose rounded-lg border border-amber-300/60 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/5 overflow-hidden">
        <div className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-400 border-b border-amber-200/60 dark:border-amber-500/20">
          <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
          <span>Mermaid 图表渲染失败</span>
        </div>
        <pre className="overflow-x-auto p-2.5 text-xs leading-relaxed font-mono text-zinc-700 dark:text-zinc-300">
          {chart}
        </pre>
      </div>
    );
  }

  return (
    <div className="mermaid-box my-3 not-prose overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 flex justify-center">
      {svg ? (
        <div className="min-w-0" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="flex items-center gap-2 py-6 text-xs text-zinc-400 dark:text-zinc-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin-fast" />
          <span>正在渲染图表...</span>
        </div>
      )}
    </div>
  );
};
