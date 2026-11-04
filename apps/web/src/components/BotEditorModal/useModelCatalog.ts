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
 * @param currentProviderId BOT 已保存的服务商标识：即使未标记 configured 也始终保留在结果中
 */
export function useModelCatalog(isOpen: boolean, nodeId: string, currentProviderId?: string) {
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

  // Providers list derived from catalog：优先展示已在节点上完成登录/配置的服务商（与设置页「已配置」同口径），
 // BOT 已保存的服务商始终保留；两者皆空时回退到有模型的服务商（再退全量），保证任何情况下都能选到模型。
  // 节点离线时的内置目录兜底无法判定配置状态，保持全量展示。
  const catalogProviders: ProviderCatalogEntry[] = useMemo(() => {
    const providers = catalog?.providers || [];
    if (catalogError) return providers;
    const seen = new Set<string>();
    const merged: ProviderCatalogEntry[] = [];
    const push = (p: ProviderCatalogEntry) => {
      if (seen.has(p.id)) return;
      seen.add(p.id);
      merged.push(p);
    };
    providers.filter((p) => p.configured || p.credentialType).forEach(push);
    if (currentProviderId) providers.filter((p) => p.id === currentProviderId).forEach(push);
    if (merged.length > 0) return merged;
    // 兜底：目录里没有任何已配置/已保存服务商时，展示收录了模型的服务商，避免服务商与型号完全无法选择
    const withModels = providers.filter((p) => (p.models?.length ?? 0) > 0);
    return withModels.length > 0 ? withModels : providers;
  }, [catalog, catalogError, currentProviderId]);

  return {
    catalog,
    loadingCatalog,
    catalogError,
    catalogProviders,
  };
}

export const THINKING_LEVEL_LABELS: Record<Exclude<ThinkingLevel, ''>, string> = {
  off: '关闭思考',
  minimal: '极简思考',
  low: '轻度思考',
  medium: '标准思考',
  high: '深度思考',
  xhigh: '超深度思考',
  max: '最大思考',
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
