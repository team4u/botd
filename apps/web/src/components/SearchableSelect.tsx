import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Search, ChevronDown, Check, Plus } from 'lucide-react';

export interface SearchableSelectOption {
  id: string;
  label: string;
  hint?: string;
}

interface SearchableSelectProps {
  options: SearchableSelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  /** Allow committing free-typed values that don't exist in options. */
  allowCustom?: boolean;
  /** A special always-visible row at the bottom of the list (e.g. custom provider trigger). */
  customTrigger?: { id: string; label: string };
  /** Label shown when the current value is not part of options (e.g. saved external id). */
  unknownValueLabel?: string;
  disabled?: boolean;
  emptyText?: string;
  maxHeight?: number;
}

/**
 * Searchable combobox rendered through a portal, so it never gets clipped by
 * scrollable modal bodies. Replaces the native <select> + separate search box
 * combo (where filtering was invisible until the dropdown was reopened).
 */
export const SearchableSelect: React.FC<SearchableSelectProps> = ({
  options,
  value,
  onChange,
  placeholder = '请选择...',
  searchPlaceholder = '搜索...',
  allowCustom = false,
  customTrigger,
  unknownValueLabel,
  disabled = false,
  emptyText = '无匹配选项',
  maxHeight = 256,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [rect, setRect] = useState<{ top: number; bottom: number; left: number; width: number } | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const showSearch = options.length > 8 || allowCustom || Boolean(customTrigger);

  const selected = useMemo(() => options.find((o) => o.id === value), [options, value]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.id.toLowerCase().includes(q) ||
        o.label.toLowerCase().includes(q) ||
        (o.hint?.toLowerCase().includes(q) ?? false)
    );
  }, [options, query]);

  const trimmedQuery = query.trim();
  const exactMatch = options.some((o) => o.id === trimmedQuery);

  const updateRect = () => {
    const box = wrapperRef.current?.getBoundingClientRect();
    if (box) setRect({ top: box.top, bottom: box.bottom, left: box.left, width: box.width });
  };

  useEffect(() => {
    if (!open) return;
    updateRect();
    searchRef.current?.focus();

    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target) || wrapperRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', updateRect);
    // capture: reposition when any scrollable ancestor (modal body) scrolls
    document.addEventListener('scroll', updateRect, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', updateRect);
      document.removeEventListener('scroll', updateRect, true);
    };
  }, [open]);

  const commit = (val: string) => {
    onChange(val);
    setOpen(false);
  };

  const flipUp = rect ? rect.bottom + maxHeight > window.innerHeight - 8 : false;

  const panelStyle: React.CSSProperties = rect
    ? {
        position: 'fixed',
        left: rect.left,
        width: rect.width,
        maxHeight,
        ...(flipUp
          ? { bottom: window.innerHeight - rect.top + 4 }
          : { top: rect.bottom + 4 }),
      }
    : { position: 'fixed', top: -9999, left: -9999 };

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          if (!open) {
            setQuery('');
            setOpen(true);
          } else {
            setOpen(false);
          }
        }}
        className="w-full px-2.5 py-1.5 text-base sm:text-xs text-left bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-500 disabled:opacity-60 flex items-center justify-between gap-2 cursor-pointer transition-colors hover:border-zinc-300 dark:hover:border-zinc-700"
      >
        <span className="truncate">
          {selected ? (
            <>
              {selected.label}
              {selected.hint && <span className="text-zinc-400 dark:text-zinc-500"> · {selected.hint}</span>}
            </>
          ) : value ? (
            unknownValueLabel || value
          ) : (
            <span className="text-zinc-400 dark:text-zinc-500">{placeholder}</span>
          )}
        </span>
        <ChevronDown
          className={`w-3.5 h-3.5 shrink-0 text-zinc-400 dark:text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            style={panelStyle}
            className="z-[70] bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-700 rounded-xl shadow-xl overflow-hidden flex flex-col animate-in fade-in"
            role="listbox"
          >
            {showSearch && (
              <div className="p-2 border-b border-zinc-100 dark:border-zinc-800/80 shrink-0 relative">
                <Search className="w-3 h-3 absolute left-4 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-zinc-500 pointer-events-none" />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={searchPlaceholder}
                  className="w-full pl-6 pr-2 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400"
                />
              </div>
            )}

            <div className="overflow-y-auto" style={{ maxHeight: maxHeight - (showSearch ? 49 : 0) }}>
              {allowCustom && trimmedQuery && !exactMatch && (
                <button
                  type="button"
                  onClick={() => commit(trimmedQuery)}
                  className="w-full px-3 py-2 text-left text-xs flex items-center gap-2 hover:bg-zinc-100 dark:hover:bg-zinc-800/80 text-zinc-700 dark:text-zinc-300 cursor-pointer transition-colors"
                >
                  <Plus className="w-3 h-3 shrink-0 text-emerald-600 dark:text-emerald-400" />
                  <span>
                    使用「<span className="font-mono">{trimmedQuery}</span>」
                  </span>
                </button>
              )}

              {filtered.map((o) => {
                const isActive = o.id === value;
                return (
                  <button
                    key={o.id}
                    type="button"
                    onClick={() => commit(o.id)}
                    role="option"
                    aria-selected={isActive}
                    className={`w-full px-3 py-2 text-left text-xs flex items-center justify-between gap-2 cursor-pointer transition-colors ${
                      isActive
                        ? 'bg-zinc-100 dark:bg-zinc-800/80 font-medium'
                        : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
                    }`}
                  >
                    <span className="truncate text-zinc-800 dark:text-zinc-200">{o.label}</span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      {o.hint && <span className="font-mono text-[10px] text-zinc-400 dark:text-zinc-500 truncate max-w-[160px]">{o.hint}</span>}
                      {isActive && <Check className="w-3 h-3 text-zinc-900 dark:text-zinc-100" />}
                    </span>
                  </button>
                );
              })}

              {filtered.length === 0 && !(allowCustom && trimmedQuery) && (
                <p className="px-3 py-4 text-xs text-zinc-400 dark:text-zinc-500 text-center">{emptyText}</p>
              )}

              {customTrigger && (
                <button
                  type="button"
                  onClick={() => commit(customTrigger.id)}
                  className="w-full px-3 py-2 text-left text-xs flex items-center gap-1.5 border-t border-zinc-100 dark:border-zinc-800/80 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 text-zinc-600 dark:text-zinc-400 cursor-pointer transition-colors"
                >
                  <Plus className="w-3 h-3" />
                  <span>{customTrigger.label}</span>
                </button>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
