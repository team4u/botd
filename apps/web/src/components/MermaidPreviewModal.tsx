import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Copy, Check, Waypoints, ZoomIn, ZoomOut } from 'lucide-react';
import { copyText } from '../utils/clipboard';

interface MermaidPreviewModalProps {
  /** Mermaid 源码（供复制） */
  chart: string;
  /** 已渲染好的 SVG 字符串（复用消息内渲染结果，避免二次渲染） */
  svg: string;
  onClose: () => void;
}

type ViewMode = 'fit' | 'zoom';

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 5;
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** 解析 svg width/height 属性中的像素值（"300"、"300px"），拒绝 "100%" 这类非固定值 */
const parsePx = (v: string | null): number => {
  if (!v) return 0;
  const m = v.trim().match(/^([\d.]+)px$/i) ?? v.trim().match(/^([\d.]+)$/);
  return m ? parseFloat(m[1]) : 0;
};

/**
 * Mermaid 图表大图预览弹窗：
 * - 默认「适屏」：SVG 矢量等比拉伸至铺满弹窗（viewBox 缩放不失真），尽可能大
 * - 缩放模式：0.2x~5x 无级缩放，超屏横纵滚动，缩放时自动保持视口居中
 * - mermaid 会在 svg 上写内联 max-width，CSS 侧用 !important 覆盖（见 index.css .mermaid-preview-fit）
 * - 交互对齐 AttachmentPreviewModal：Esc / 点击遮罩空白关闭，顶栏复制源码
 */
export const MermaidPreviewModal: React.FC<MermaidPreviewModalProps> = ({ chart, svg, onClose }) => {
  const [copied, setCopied] = useState(false);
  const [mode, setMode] = useState<ViewMode>('fit');
  const [zoom, setZoom] = useState(1);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // 测量图表自然尺寸（读取属性而非布局值，不受适屏 CSS 拉伸影响）
  useEffect(() => {
    const svgEl = stageRef.current?.querySelector('svg');
    if (!svgEl) return;
    const w = parsePx(svgEl.getAttribute('width')) || svgEl.viewBox?.baseVal?.width || 0;
    const h = parsePx(svgEl.getAttribute('height')) || svgEl.viewBox?.baseVal?.height || 0;
    if (w > 0 && h > 0) setNatural({ w, h });
  }, [svg]);

  // 缩放模式下切换倍数时保持视口居中
  useEffect(() => {
    const el = stageRef.current;
    if (!el || mode !== 'zoom') return;
    el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
    el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
  }, [mode, zoom]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** 当前适屏缩放比（以舞台可用区域与自然尺寸估算，用于从适屏无缝衔接放大/缩小） */
  const fitScale = useCallback((): number => {
    const el = stageRef.current;
    if (!el || !natural) return 1;
    const rect = el.getBoundingClientRect();
    const scale = Math.min((rect.width - 48) / natural.w, (rect.height - 48) / natural.h);
    return Number.isFinite(scale) && scale > 0 ? clampZoom(scale) : 1;
  }, [natural]);

  const zoomBy = (factor: number) => {
    if (!natural) return;
    if (mode === 'fit') {
      setZoom(clampZoom(fitScale() * factor));
      setMode('zoom');
    } else {
      setZoom((z) => clampZoom(z * factor));
    }
  };

  /** 双击切换：适屏 ↔ 100% */
  const handleDoubleClick = () => {
    if (!natural) return;
    if (mode === 'fit') {
      setZoom(1);
      setMode('zoom');
    } else {
      setMode('fit');
    }
  };

  const handleCopy = useCallback(async () => {
    const ok = await copyText(chart);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    }
  }, [chart]);

  const iconBtn =
    'p-1.5 rounded-lg text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer';
  const pillIconBtn =
    'w-7 h-7 flex items-center justify-center rounded-full text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer';
  const pillTextBtn =
    'h-7 px-2 flex items-center rounded-full text-[11px] font-medium text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors cursor-pointer select-none';

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/60 dark:bg-black/80 backdrop-blur-xs flex flex-col animate-in fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="Mermaid 图表预览"
    >
      {/* 顶栏：标题 + 复制源码 + 关闭 */}
      <div className="flex items-center gap-2 px-3 sm:px-4 h-13 sm:h-14 bg-white dark:bg-zinc-950 border-b border-zinc-200/80 dark:border-zinc-800/80 shrink-0">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Waypoints className="w-4 h-4 text-zinc-400 dark:text-zinc-500 shrink-0" />
          <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">
            Mermaid 图表预览
          </span>
        </div>

        <button
          type="button"
          onClick={handleCopy}
          className={iconBtn}
          title={copied ? '已复制' : '复制 Mermaid 源码'}
          aria-label="复制 Mermaid 源码"
        >
          {copied ? (
            <Check className="w-4 h-4 text-emerald-500 dark:text-emerald-400" />
          ) : (
            <Copy className="w-4 h-4" />
          )}
        </button>

        <button type="button" onClick={onClose} className={iconBtn} title="关闭 (Esc)" aria-label="关闭">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 主体：点击空白处关闭；双击图表切换 适屏/100% */}
      <div
        ref={stageRef}
        className="flex-1 min-h-0 overflow-auto p-3 sm:p-6"
        onClick={onClose}
      >
        {mode === 'fit' || !natural ? (
          /* 适屏：SVG 拉伸铺满舞台（.mermaid-preview-fit，viewBox 等比缩放） */
          <div
            className="mermaid-preview-fit w-full h-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-2 shadow-lg"
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={handleDoubleClick}
          >
            <div className="w-full h-full" dangerouslySetInnerHTML={{ __html: svg }} />
          </div>
        ) : (
          /* 缩放：按自然尺寸 × zoom 变换，外层占位撑开滚动区域 */
          <div
            className="mx-auto w-fit rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-4 shadow-lg"
            style={{ width: natural.w * zoom + 32, height: natural.h * zoom + 32 }}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={handleDoubleClick}
          >
            <div
              style={{
                width: natural.w,
                height: natural.h,
                transform: `scale(${zoom})`,
                transformOrigin: 'top left',
              }}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        )}
      </div>

      {/* 底部居中缩放控制条 */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex items-center gap-0.5 h-9 px-1.5 rounded-full bg-white/95 dark:bg-zinc-900/95 border border-zinc-200 dark:border-zinc-700/80 shadow-lg backdrop-blur-xs">
        <button type="button" onClick={() => zoomBy(1 / 1.25)} className={pillIconBtn} title="缩小" aria-label="缩小">
          <ZoomOut className="w-4 h-4" />
        </button>
        <span className="w-14 text-center text-xs font-mono text-zinc-500 dark:text-zinc-400 select-none" title="当前缩放比例（双击图表可切换适屏/100%）">
          {mode === 'fit' ? '适屏' : `${Math.round(zoom * 100)}%`}
        </span>
        <button type="button" onClick={() => zoomBy(1.25)} className={pillIconBtn} title="放大" aria-label="放大">
          <ZoomIn className="w-4 h-4" />
        </button>
        <div className="w-px h-4 bg-zinc-200 dark:bg-zinc-700 mx-1" />
        <button
          type="button"
          onClick={() => setMode('fit')}
          className={pillTextBtn}
          title="铺满窗口（尽可能大）"
        >
          适屏
        </button>
        <button
          type="button"
          onClick={() => {
            if (!natural) return;
            setZoom(1);
            setMode('zoom');
          }}
          className={pillTextBtn}
          title="原始尺寸"
        >
          1:1
        </button>
      </div>
    </div>,
    document.body
  );
};
