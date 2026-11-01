import { useState, useEffect } from 'react';

/**
 * 移动端虚拟键盘高度自适应核心 Hook
 *
 * 核心原理（垫片补偿算法）：
 * 1. 在 Android Chrome（开启 interactive-widget=resizes-content）中：
 *    软键盘弹起时 layout viewport 会自动缩小，window.innerHeight 与 visualViewport.height 同步缩小，
 *    二者差值约为 0，浏览器原生收缩视口，不需要任何垫片。
 * 2. 在 iOS Safari / 微信 WKWebView 中：
 *    软键盘弹起时 window.innerHeight 不缩小，只有 window.visualViewport 缩小；
 *    且 Safari 会强行把 visualViewport 向上滚动（产生 visualViewport.offsetTop > 0）。
 *    此时：当前可视区域的底部是 vv.offsetTop + vv.height；
 *    页面底端到当前可视区域底端的真实被遮挡高度精确等于：
 *    window.innerHeight - (vv.offsetTop + vv.height)
 *    无论 Safari 怎么上推/偏移，该公式计算出的高度刚好等于软键盘物理高度与屏幕底部的重叠区！
 *    将此高度作为垫片垫在输入框下方，输入框便能在所有机型上 100% 精确咬合吸附在软键盘顶端！
 */
const getKeyboardInset = (): number => {
  if (typeof window === 'undefined') return 0;
  const vv = window.visualViewport;
  if (!vv) return 0;

  // 可视区域下沿距整个 Layout 底部的距离
  const rawInset = window.innerHeight - (vv.offsetTop + vv.height);
  // 过滤地址栏展开收起等微小波动（通常 <= 50px）
  return rawInset > 50 ? Math.round(rawInset) : 0;
};

export const useKeyboardInset = (): number => {
  const [inset, setInset] = useState<number>(() => getKeyboardInset());

  useEffect(() => {
    if (typeof window === 'undefined') return;

    let rafId: number | null = null;
    const update = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const next = getKeyboardInset();
        setInset(next);
        document.documentElement.classList.toggle('keyboard-open', next > 0);
      });
    };

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', update);
      vv.addEventListener('scroll', update);
    }
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);

    // 聚焦时 iOS 会进行动画，多频次校准
    const handleFocusIn = (e: FocusEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'textarea' || tag === 'input') {
        setTimeout(update, 50);
        setTimeout(update, 150);
        setTimeout(update, 350);
      }
    };
    window.addEventListener('focusin', handleFocusIn);

    update();

    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      if (vv) {
        vv.removeEventListener('resize', update);
        vv.removeEventListener('scroll', update);
      }
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
      window.removeEventListener('focusin', handleFocusIn);
    };
  }, []);

  return inset;
};

export const initViewportAdjustment = (): void => {
  // 保留供 main.tsx 全局挂载与首屏类名同步
  if (typeof window === 'undefined') return;
  const vv = window.visualViewport;
  const sync = () => {
    const inset = getKeyboardInset();
    document.documentElement.classList.toggle('keyboard-open', inset > 0);
  };
  if (vv) {
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
  }
};
