import React, { useState, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import { Check, Copy } from 'lucide-react';
import { MermaidBlock } from './MermaidBlock.js';
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
 * 自定义代码块组件：语言顶栏（语言标识 + 复制按钮）与代码区上下分离，横向滚动
 * （react-markdown 会额外传入 hast 的 node 属性，需从 DOM props 中剔除）
 * ```mermaid 代码块在此层拦截，交给 MermaidBlock 渲染（避免 div 嵌套进 pre）
 */
const PreBlock: React.FC<React.ComponentPropsWithoutRef<'pre'> & { node?: unknown }> = ({
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

  // 从 <code class="language-xxx"> 中提取语言标识，无标记时回退解析子节点 className
  const detectLanguage = (): string => {
    const fromChild =
      childProps && typeof childProps.className === 'string'
        ? /language-([\w+-]+)/.exec(childProps.className)?.[1]
        : undefined;
    if (fromChild) return fromChild;
    const codeEl = preRef.current?.querySelector('code');
    const cls = codeEl?.className || '';
    return /language-([\w+-]+)/.exec(cls)?.[1] || '';
  };

  const language = detectLanguage();

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
    <div className="relative group/code my-3 not-prose overflow-hidden rounded-xl border border-zinc-700/60 bg-zinc-900 shadow-sm">
      {/* 语言顶栏：左侧语言标识，右侧复制按钮，与代码区上下分离互不遮挡 */}
      <div className="flex items-center justify-between h-8 px-3 border-b border-zinc-700/50 bg-zinc-800/60 select-none">
        <span className="font-mono text-[11px] text-zinc-400 truncate">
          {language || 'text'}
        </span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? '已复制代码' : '复制代码'}
          title={copied ? '已复制' : '复制代码'}
          className="inline-flex items-center gap-1 h-6 px-1.5 rounded-md text-[11px] font-medium text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/60 transition-colors cursor-pointer"
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
      <pre
        ref={preRef}
        {...props}
        className="!my-0 overflow-x-auto px-3.5 py-3 bg-zinc-900 text-zinc-100 text-[13px] font-mono leading-relaxed"
      >
        {children}
      </pre>
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
 * - 代码块统一走 PreBlock（语言顶栏 + 复制按钮 + 横向滚动）
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
