import React, { useState, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';

/**
 * 自定义代码块组件：带右上角一键复制及横向滚动
 * （react-markdown 会额外传入 hast 的 node 属性，需从 DOM props 中剔除）
 */
export const PreBlock: React.FC<React.ComponentPropsWithoutRef<'pre'> & { node?: unknown }> = ({
  node: _node,
  children,
  ...props
}) => {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const handleCopy = async () => {
    if (!preRef.current) return;
    const codeEl = preRef.current.querySelector('code');
    const textToCopy = (codeEl ? codeEl.innerText : preRef.current.innerText).replace(/\n$/, '');
    try {
      await navigator.clipboard.writeText(textToCopy);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // 降级兜底
    }
  };

  return (
    <div className="relative group/code my-3 not-prose">
      <pre
        ref={preRef}
        {...props}
        className="!my-0 overflow-x-auto rounded-xl p-3.5 bg-zinc-900 text-zinc-100 text-[13px] font-mono leading-relaxed"
      >
        {children}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        aria-label={copied ? '已复制代码' : '复制代码'}
        title={copied ? '已复制' : '复制代码'}
        className="absolute top-2.5 right-2.5 flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-zinc-800/90 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-opacity border border-zinc-700/60 shadow-xs backdrop-blur-xs opacity-90 sm:opacity-0 sm:group-hover/code:opacity-100 focus:opacity-100 cursor-pointer"
      >
        {copied ? (
          <>
            <Check className="w-3.5 h-3.5 text-emerald-400" />
            <span className="text-emerald-400">已复制</span>
          </>
        ) : (
          <>
            <Copy className="w-3.5 h-3.5" />
            <span>复制</span>
          </>
        )}
      </button>
    </div>
  );
};

interface MarkdownProps {
  children: string;
}

/**
 * 统一 Markdown 渲染入口：
 * - remark-gfm 支持表格、删除线、任务列表、自动链接等 GFM 语法
 * - rehype-highlight 为代码块提供轻量级语法高亮（highlight.js）
 * - 代码块统一走 PreBlock（复制按钮 + 横向滚动）
 */
export const Markdown: React.FC<MarkdownProps> = ({ children }) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    rehypePlugins={[rehypeHighlight]}
    components={{ pre: PreBlock }}
  >
    {children}
  </ReactMarkdown>
);
