import React, { useState, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import { Check, Copy } from 'lucide-react';
import { MermaidBlock } from './MermaidBlock';
import { UiSpecBlock } from './generative-ui/BotdUiRenderer.js';
import 'katex/dist/katex.min.css';

/** 递归提取 React 子节点中的纯文本（用于取出 mermaid 源码） */
const extractText = (node: React.ReactNode): string => {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (React.isValidElement(node)) return extractText((node.props as { children?: React.ReactNode }).children);
  return '';
};

/**
 * 自定义代码块组件：带右上角一键复制及横向滚动
 * （react-markdown 会额外传入 hast 的 node 属性，需从 DOM props 中剔除）
 * ```mermaid 代码块在此层拦截，交给 MermaidBlock 渲染（避免 div 嵌套进 pre）
 */
export const PreBlock: React.FC<React.ComponentPropsWithoutRef<'pre'> & { node?: unknown }> = ({
  node: _node,
  children,
  ...props
}) => {
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  // mermaid / ui 块：子元素是 <code class="language-mermaid"> 或 <code class="language-ui"> / <code class="language-json-render">
  const child = Array.isArray(children) ? children[0] : children;
  const childProps = React.isValidElement(child)
    ? (child.props as { className?: unknown; children?: React.ReactNode })
    : null;
  if (childProps && typeof childProps.className === 'string') {
    if (childProps.className.includes('language-mermaid')) {
      const chart = extractText(childProps.children).replace(/\n$/, '');
      return <MermaidBlock chart={chart} />;
    }
    if (childProps.className.includes('language-ui') || childProps.className.includes('language-json-render')) {
      const raw = extractText(childProps.children).replace(/\n$/, '');
      return <UiSpecBlock raw={raw} />;
    }
  }

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
 * - remark-math + rehype-katex 支持 $...$ / $$...$$ 数学公式
 * - rehype-highlight 为代码块提供轻量级语法高亮（highlight.js）
 * - 代码块统一走 PreBlock（复制按钮 + 横向滚动）
 * - ```mermaid 代码块由 PreBlock 拦截，交给 MermaidBlock 渲染流程图/时序图等
 */
export const Markdown: React.FC<MarkdownProps> = ({ children }) => (
  <ReactMarkdown
    remarkPlugins={[remarkGfm, remarkMath]}
    rehypePlugins={[[rehypeHighlight, { plainText: ['mermaid', 'math'] }], rehypeKatex]}
    components={{ pre: PreBlock }}
  >
    {children}
  </ReactMarkdown>
);
