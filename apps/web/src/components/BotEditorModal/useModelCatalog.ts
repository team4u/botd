import { useEffect, useMemo, useState } from 'react';
import type {
  ModelCatalog,
  ModelCatalogEntry,
  ProviderCatalogEntry,
  ThinkingLevel,
} from '@botd/protocol';
import { api } from '../../api';

/**
 * 模型目录拉取与派生：按节点拉取 catalog（节点离线时兜底全局内置目录），
 * 并派生可用服务商、当前服务商的模型列表、选中模型元数据与其支持的思考档位。
 */
export function useModelCatalog(isOpen: boolean, nodeId: string) {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  // Fetch catalog when selected node changes
  useEffect(() => {
    if (!isOpen) return;
    let active = true;

    setLoadingCatalog(true);
    setCatalogError(null);

    // Call /api/models/catalog?nodeId=... for selected node
    api.getModelCatalog(nodeId || undefined)
      .then((data) => {
        if (!active) return;
        setCatalog(data);
      })
      .catch((err: any) => {
        if (!active) return;
        // If node catalog fails (e.g. 503 offline), fallback to builtin catalog
        if (nodeId) {
          setCatalogError(`无法获取节点专属模型目录 (${err?.message || '503'})，已切换为全局内置目录`);
          api.getModelCatalog()
            .then((fallbackData) => {
              if (active) setCatalog(fallbackData);
            })
            .catch(() => {
              // fallback failed too
            });
        } else {
          setCatalogError(err?.message || '加载模型目录失败');
        }
      })
      .finally(() => {
        if (active) setLoadingCatalog(false);
      });

    return () => {
      active = false;
    };
  }, [isOpen, nodeId]);

  // Providers list derived from catalog：严格只保留已配置凭据的服务商（与设置页「已配置」同口径）。
  // 未配置凭据的 provider 绝不进入可选列表，避免用户选中后发送即失败；
  // 仅当 catalog 加载失败（节点离线等）无法判定配置状态时，才保留原样以便浏览。
  const catalogProviders: ProviderCatalogEntry[] = useMemo(() => {
    const providers = catalog?.providers || [];
    if (catalogError) return providers;
    return providers.filter((p) => p.configured || Boolean(p.credentialType));
  }, [catalog, catalogError]);

  return {
    catalog,
    loadingCatalog,
    catalogError,
    catalogProviders,
  };
}

/** 思考档位直接显示英文原值（off/minimal/low/medium/high/xhigh/max），不做中文映射。 */
export const THINKING_LEVEL_LABELS: Record<Exclude<ThinkingLevel, ''>, string> = {
  off: 'off',
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

/** 模型支持的思考档位：优先取目录元数据，缺失时回退全量档位。 */
export function deriveModelThinkingLevels(
  modelMeta: ModelCatalogEntry | null
): Exclude<ThinkingLevel, ''>[] {
  const levels = modelMeta?.thinkingLevels?.filter(Boolean);
  if (levels && levels.length > 0) return levels as Exclude<ThinkingLevel, ''>[];
  // Fallback for models without catalog metadata (custom ids, empty catalogs)
  return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
}

/** 模型不再支持当前思考档位时，选取最近的支持档位（优先更深，其次更浅）。 */
export function clampThinkingLevel(
  current: Exclude<ThinkingLevel, ''>,
  supported: Exclude<ThinkingLevel, ''>[]
): Exclude<ThinkingLevel, ''> | null {
  const ORDER: Exclude<ThinkingLevel, ''>[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (supported.includes(current)) return null;
  const idx = ORDER.indexOf(current);
  for (let i = idx; i < ORDER.length; i++) {
    if (supported.includes(ORDER[i])) return ORDER[i];
  }
  for (let i = idx - 1; i >= 0; i--) {
    if (supported.includes(ORDER[i])) return ORDER[i];
  }
  return null;
}
