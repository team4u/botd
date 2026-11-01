import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  X,
  Settings,
  Key,
  Loader2,
  CheckCircle2,
  Info,
  Search,
  Server,
  ShieldCheck,
  ExternalLink,
  Cpu,
  AlertCircle,
  RefreshCw,
  LogOut,
  ChevronRight,
  ChevronLeft,
  Sparkles,
} from 'lucide-react';
import { api } from '../api';
import { ProviderAuthModal } from './ProviderAuthModal';
import { ConfirmDialog } from './ConfirmDialog';
import type {
  ModelCatalog,
  ProviderCatalogEntry,
  ProviderAuthType,
  NodeWithBots,
} from '@botd/protocol';

interface SettingsModalProps {
  isOpen: boolean;
  nodes?: NodeWithBots[];
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  nodes: propNodes,
  onClose,
}) => {
  // Online nodes state
  const [nodesList, setNodesList] = useState<NodeWithBots[]>(propNodes || []);
  const [selectedNodeId, setSelectedNodeId] = useState<string>('');

  // Catalog state
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  // UI state
  const [searchQuery, setSearchQuery] = useState('');
  const [filterConfiguredOnly, setFilterConfiguredOnly] = useState(false);
  const [selectedProviderId, setSelectedProviderId] = useState<string>('');
  const [mobileTab, setMobileTab] = useState<'list' | 'detail'>('list');

  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const catalogEpoch = useRef(0);
  const detailPaneRef = useRef<HTMLDivElement>(null);
  const openRef = useRef(isOpen);
  openRef.current = isOpen;

  // Node Auth Modal state
  const [activeAuthTarget, setActiveAuthTarget] = useState<{
    nodeId: string;
    nodeName: string;
    providerId: string;
    providerName: string;
    authMethod: { type: ProviderAuthType; label: string; interactive: boolean; subscription: boolean };
  } | null>(null);

  // Logout / clear node credential state
  const [clearingAuth, setClearingAuth] = useState(false);
  // ConfirmDialog state for clearing node credentials
  const [clearAuthProviderId, setClearAuthProviderId] = useState<string | null>(null);

  // Online nodes list
  const onlineNodes = useMemo(() => {
    return nodesList.filter((n) => n.status === 'online');
  }, [nodesList]);

  // Keep propNodes in sync
  useEffect(() => {
    if (propNodes !== undefined) setNodesList(propNodes);
  }, [propNodes]);

  // Load catalog for chosen node (or global builtin)
  const fetchCatalog = useCallback(async (nodeId?: string) => {
    const epoch = ++catalogEpoch.current;
    setCatalogLoading(true);
    setCatalogError(null);
    try {
      const data = await api.getModelCatalog(nodeId || undefined);
      if (openRef.current && epoch === catalogEpoch.current) setCatalog(data);
    } catch (err: any) {
      if (!openRef.current || epoch !== catalogEpoch.current) return;
      if (nodeId) {
        setCatalogError(`无法获取所选节点目录 (${err?.message || '节点离线'})，当前显示内置目录`);
        try {
          const fallbackData = await api.getModelCatalog();
          if (openRef.current && epoch === catalogEpoch.current) setCatalog(fallbackData);
        } catch {
          if (epoch === catalogEpoch.current) setCatalog(null);
        }
      } else {
        setCatalog(null);
        setCatalogError(err?.message || '读取模型目录失败');
      }
    } finally {
      if (openRef.current && epoch === catalogEpoch.current) setCatalogLoading(false);
    }
  }, []);

  // Initial load when modal opens
  useEffect(() => {
    let current = true;
    if (!isOpen) {
      setError(null);
      setSuccess(false);
      return;
    }

    setError(null);
    setSuccess(false);

    // If nodes not provided, fetch them
    const nodesPromise =
      propNodes && propNodes.length > 0
        ? Promise.resolve(propNodes)
        : api.getNodes().catch(() => []);

    nodesPromise
      .then((fetchedNodes) => {
        if (!current) return;
        setNodesList(fetchedNodes || []);

        // Auto-select first online node if none selected
        const online = (fetchedNodes || []).filter((n: NodeWithBots) => n.status === 'online');
        const defaultNode = online[0]?.id || '';
        setSelectedNodeId(defaultNode);

        // Fetch catalog with default node if available
        return fetchCatalog(defaultNode || undefined);
      })
      .catch((err) => {
        if (!current) return;
        setError(err?.message || '读取配置失败');
      });

    return () => {
      current = false;
      catalogEpoch.current++;
    };
  }, [isOpen, fetchCatalog]);

  useEffect(() => {
    detailPaneRef.current?.scrollTo({ top: 0 });
  }, [selectedProviderId]);

  // When selected node changes in the node picker
  const handleNodeChange = (newNodeId: string) => {
    setSelectedNodeId(newNodeId);
    fetchCatalog(newNodeId || undefined);
  };

  const allProviders = useMemo(() => {
    return catalog?.providers ? [...catalog.providers] : [];
  }, [catalog]);

  // 节点凭据判定：仅依据节点目录返回的 credentialType / configured
  const providerHasNodeAuth = useCallback((p: ProviderCatalogEntry) => {
    return Boolean(selectedNodeId && !catalogError && (p.credentialType || p.configured));
  }, [selectedNodeId, catalogError]);

  // Filtered providers
  const filteredProviders = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return allProviders.filter((p) => {
      if (filterConfiguredOnly && !providerHasNodeAuth(p)) {
        return false;
      }
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q);
    });
  }, [allProviders, searchQuery, filterConfiguredOnly, providerHasNodeAuth]);

  // Set default selected provider if current is not in list
  useEffect(() => {
    if (!selectedProviderId && filteredProviders.length > 0) {
      setSelectedProviderId(filteredProviders[0].id);
    } else if (
      selectedProviderId &&
      !allProviders.some((p) => p.id === selectedProviderId) &&
      filteredProviders.length > 0
    ) {
      setSelectedProviderId(filteredProviders[0].id);
    }
  }, [selectedProviderId, filteredProviders, allProviders]);

  const selectedProvider = useMemo(() => {
    return allProviders.find((p) => p.id === selectedProviderId) || filteredProviders[0] || null;
  }, [allProviders, selectedProviderId, filteredProviders]);

  // Count configured
  const configuredCount = useMemo(() => {
    return allProviders.filter((p) => providerHasNodeAuth(p)).length;
  }, [allProviders, providerHasNodeAuth]);

  if (!isOpen) return null;

  const handleClearNodeAuth = (providerId: string) => {
    if (!selectedNodeId) return;
    setClearAuthProviderId(providerId);
  };

  const confirmClearNodeAuth = async () => {
    if (!selectedNodeId || !clearAuthProviderId) return;
    const providerId = clearAuthProviderId;
    setClearingAuth(true);
    setError(null);
    try {
      await api.logoutProviderAuth(selectedNodeId, providerId);
      setClearAuthProviderId(null);
      await fetchCatalog(selectedNodeId);
      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      setError(err?.message || '清除节点凭据失败');
    } finally {
      setClearingAuth(false);
    }
  };

  const handleStartNodeLogin = (
    provider: ProviderCatalogEntry,
    method: { type: ProviderAuthType; label: string; interactive: boolean; subscription: boolean }
  ) => {
    if (!selectedNodeId) {
      setError('请先在上方选择一个在线节点以执行授权');
      return;
    }
    const node = nodesList.find((n) => n.id === selectedNodeId);
    setActiveAuthTarget({
      nodeId: selectedNodeId,
      nodeName: node?.name || selectedNodeId,
      providerId: provider.id,
      providerName: provider.name,
      authMethod: method,
    });
  };

  const selectedNode = nodesList.find((n) => n.id === selectedNodeId);
  const hasNodeCredential = Boolean(selectedProvider && providerHasNodeAuth(selectedProvider));

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/50 dark:bg-black/70 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-hidden animate-in fade-in"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
      >
        <div className="bg-white dark:bg-zinc-950 rounded-t-2xl sm:rounded-2xl shadow-2xl border border-zinc-200 dark:border-zinc-800 max-w-4xl w-full overflow-hidden flex flex-col h-[92dvh] sm:h-[90vh] sm:max-h-[820px]">
          {/* Mobile pull indicator */}
          <div className="sm:hidden pt-2.5 pb-1 flex justify-center shrink-0">
            <div className="w-9 h-1 rounded-full bg-zinc-300 dark:bg-zinc-700" />
          </div>

          {/* Header */}
          <div className="px-5 sm:px-6 py-3.5 border-b border-zinc-200/80 dark:border-zinc-800/80 flex items-center justify-between shrink-0 bg-zinc-50/60 dark:bg-zinc-900/60">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 flex items-center justify-center shadow-xs">
                <Settings className="w-4 h-4" />
              </div>
              <div>
                <h2 id="settings-modal-title" className="text-sm sm:text-base font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-2">
                  <span>模型与服务商设置</span>
                  {catalog?.sdkVersion && (
                    <span className="text-[11px] font-mono px-2 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 rounded-md font-semibold">
                      v{catalog.sdkVersion}
                    </span>
                  )}
                </h2>
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400 hidden sm:block">
                  管理各节点的模型服务凭据（API Key / OAuth）
                </p>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => fetchCatalog(selectedNodeId || undefined)}
                disabled={catalogLoading}
                className="p-1.5 text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg transition-colors"
                title="刷新目录"
              >
                <RefreshCw className={`w-4 h-4 ${catalogLoading ? 'animate-spin' : ''}`} />
              </button>
              <button
                onClick={onClose}
                className="p-1.5 text-zinc-400 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-200 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                aria-label="关闭对话框"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Node Scope Bar - Compact on Mobile */}
          <div className="px-4 sm:px-6 py-2 bg-zinc-50/90 dark:bg-zinc-900/90 border-b border-zinc-200/80 dark:border-zinc-800/80 flex items-center justify-between gap-2 shrink-0 text-xs">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <Server className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400 shrink-0" />
              <span className="text-zinc-600 dark:text-zinc-400 font-medium shrink-0 hidden sm:inline">关联节点:</span>
              <select
                value={selectedNodeId}
                onChange={(e) => handleNodeChange(e.target.value)}
                className="px-2 py-1 text-xs bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 font-medium text-zinc-800 dark:text-zinc-200 max-w-[200px] sm:max-w-none truncate"
                aria-label="选择关联节点"
              >
                <option value="" className="dark:bg-zinc-900 dark:text-zinc-100">全部（内置目录）</option>
                {onlineNodes.map((n) => (
                  <option key={n.id} value={n.id} className="dark:bg-zinc-900 dark:text-zinc-100">
                    🟢 {n.name} ({n.platform})
                  </option>
                ))}
              </select>
              {selectedNodeId && (
                <span className="hidden md:inline text-[11px] text-emerald-700 dark:text-emerald-300 font-mono truncate">
                  {selectedNode?.name || selectedNodeId} 已连接
                </span>
              )}
            </div>

            <div className="text-[11px] text-zinc-500 dark:text-zinc-400 flex items-center gap-2 shrink-0">
              <span className="hidden sm:inline">
                服务商: <strong className="text-zinc-700 dark:text-zinc-300">{allProviders.length}</strong>
              </span>
              <span className="hidden sm:inline text-zinc-300 dark:text-zinc-700">|</span>
              <span className="text-emerald-700 dark:text-emerald-300 font-medium">
                已配置: <strong className="font-semibold">{configuredCount}</strong>
              </span>
            </div>
          </div>

          {/* Alert messages */}
          {error && (
            <div className="mx-4 sm:mx-6 mt-3 p-3 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 text-rose-700 dark:text-rose-300 text-xs rounded-xl flex items-start gap-2 shrink-0">
              <AlertCircle className="w-4 h-4 text-rose-500 dark:text-rose-400 shrink-0 mt-0.5" />
              <div className="flex-1">{error}</div>
            </div>
          )}

          {catalogError && (
            <div className="mx-4 sm:mx-6 mt-3 p-3 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60 text-amber-800 dark:text-amber-300 text-xs rounded-xl flex items-start gap-2 shrink-0">
              <Info className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
              <div className="flex-1">{catalogError}</div>
            </div>
          )}

          {success && (
            <div className="mx-4 sm:mx-6 mt-3 p-3 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-900/60 text-emerald-800 dark:text-emerald-300 text-xs rounded-xl flex items-center gap-2 shrink-0">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
              <span>操作成功！配置已更新。</span>
            </div>
          )}

          {/* Master-Detail Layout */}
          <div className="flex-1 flex overflow-hidden">
            {/* Left pane: Providers list & search */}
            <div
              className={`w-full sm:w-80 border-r border-zinc-200/80 dark:border-zinc-800/80 flex flex-col bg-zinc-50/40 dark:bg-zinc-900/40 shrink-0 ${
                mobileTab === 'detail' ? 'hidden sm:flex' : 'flex'
              }`}
            >
              {/* Search & filter */}
              <div className="p-3 border-b border-zinc-200/80 dark:border-zinc-800/80 bg-white dark:bg-zinc-950 shrink-0">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-zinc-400 dark:text-zinc-500 pointer-events-none" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="搜索服务商名称或标识..."
                    className="w-full pl-8 pr-7 py-1.5 text-xs bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg focus:bg-white dark:focus:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 text-zinc-800 dark:text-zinc-200 placeholder-zinc-400 dark:placeholder-zinc-500"
                  />
                  {searchQuery && (
                    <button
                      onClick={() => setSearchQuery('')}
                      className="absolute right-2.5 top-2 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300 text-xs p-0.5"
                    >
                      ×
                    </button>
                  )}
                </div>

                <div className="flex items-center justify-between text-xs mt-2">
                  <button
                    type="button"
                    onClick={() => setFilterConfiguredOnly(!filterConfiguredOnly)}
                    className={`px-2.5 py-1 rounded-lg text-[11px] font-medium border transition-colors ${
                      filterConfiguredOnly
                        ? 'bg-indigo-50/70 dark:bg-indigo-950/40 border-indigo-300 dark:border-indigo-800 text-indigo-950 dark:text-indigo-200'
                        : 'bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                    }`}
                  >
                    {filterConfiguredOnly ? '✓ 仅已配置' : '全部服务商'}
                  </button>
                </div>
              </div>

              {/* Providers list */}
              <div className="flex-1 overflow-y-auto p-2 space-y-1">
                {catalogLoading && !catalog ? (
                  <div className="py-12 flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-500 gap-2">
                    <Loader2 className="w-4 h-4 animate-spin text-zinc-600 dark:text-zinc-400" />
                    <span className="text-xs">加载服务商目录...</span>
                  </div>
                ) : filteredProviders.length === 0 ? (
                  <div className="py-10 text-center text-zinc-400 dark:text-zinc-500 text-xs">
                    未找到匹配的服务商
                  </div>
                ) : (
                  filteredProviders.map((provider) => {
                    const isSelected = selectedProvider?.id === provider.id;
                    const hasAuth = providerHasNodeAuth(provider);

                    return (
                      <button
                        key={provider.id}
                        type="button"
                        onClick={() => {
                          setSelectedProviderId(provider.id);
                          setMobileTab('detail');
                        }}
                        className={`w-full text-left p-2.5 rounded-xl border transition-all flex items-center justify-between ${
                          isSelected
                            ? 'bg-zinc-100 dark:bg-zinc-800 border-zinc-300 dark:border-zinc-700 shadow-2xs font-medium'
                            : 'bg-white dark:bg-zinc-950 border-zinc-200/70 dark:border-zinc-800/70 hover:bg-zinc-50 dark:hover:bg-zinc-900'
                        }`}
                      >
                        <div className="min-w-0 flex-1 pr-2">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 truncate">
                              {provider.name}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400 truncate">
                              {provider.id}
                            </span>
                            {provider.models && provider.models.length > 0 && (
                              <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                                · {provider.models.length} 款模型
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Status badges */}
                        <div className="flex items-center gap-1.5 shrink-0">
                          {hasAuth && (
                            <span
                              className="w-2 h-2 rounded-full bg-emerald-600 dark:bg-emerald-400"
                              title="已配置节点专属凭据"
                            />
                          )}
                          <ChevronRight className="w-3.5 h-3.5 text-zinc-300 dark:text-zinc-600" />
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* Right pane: Detail for selected provider */}
            <div
              ref={detailPaneRef}
              className={`flex-1 overflow-y-auto p-4 sm:p-6 space-y-5 ${
                mobileTab === 'list' ? 'hidden sm:block' : 'block'
              }`}
            >
              {selectedProvider ? (
                <>
                  {/* Mobile Back Button - Master-Detail Transition */}
                  <div className="sm:hidden pb-2 mb-1 border-b border-zinc-200/80 dark:border-zinc-800/80 flex items-center justify-between shrink-0">
                    <button
                      type="button"
                      onClick={() => setMobileTab('list')}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-700 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 rounded-lg transition-colors"
                    >
                      <ChevronLeft className="w-4 h-4" />
                      <span>返回服务商列表</span>
                    </button>
                    <span className="text-xs text-zinc-400 dark:text-zinc-500 font-mono">
                      {selectedProvider.id}
                    </span>
                  </div>

                  {/* Selected Provider Header Info */}
                  <div className="flex items-start justify-between gap-4 pb-3 border-b border-zinc-200/80 dark:border-zinc-800/80">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm sm:text-base font-bold text-zinc-900 dark:text-zinc-100">
                          {selectedProvider.name}
                        </h3>
                        <span className="font-mono text-xs text-zinc-600 dark:text-zinc-300 bg-zinc-100 dark:bg-zinc-800 px-2 py-0.5 rounded-md border border-zinc-200 dark:border-zinc-700 font-medium">
                          {selectedProvider.id}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                        收录模型: <strong className="text-zinc-700 dark:text-zinc-300">{selectedProvider.models?.length || 0}</strong> 款 · 认证方式:{' '}
                        {selectedProvider.authMethods && selectedProvider.authMethods.length > 0
                          ? selectedProvider.authMethods.map((m) => m.label || m.type).join('、')
                          : 'API Key'}
                      </p>
                    </div>
                  </div>

                  {/* Section: Node SDK Native Auth */}
                  <div className="p-4 bg-zinc-50/70 dark:bg-zinc-900/70 border border-zinc-200/90 dark:border-zinc-800/90 rounded-2xl space-y-3.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                        <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100">
                          节点专属凭据
                        </span>
                      </div>

                      {hasNodeCredential ? (
                        <span className="text-[11px] font-medium text-emerald-800 dark:text-emerald-200 bg-emerald-100/80 dark:bg-emerald-950/60 px-2 py-0.5 rounded-full flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-600 dark:bg-emerald-400" />
                          <span>
                            {selectedProvider.credentialType
                              ? `已授权 (${selectedProvider.credentialType.toUpperCase()})`
                              : '已存储凭据'}
                          </span>
                        </span>
                      ) : (
                        <span className="text-[11px] text-zinc-400 dark:text-zinc-500">节点无本地凭据</span>
                      )}
                    </div>

                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
                      通过 SDK 原生交互完成授权登录，凭据隔离保存在选定节点的 <code>~/.botd/.agent/auth.json</code> 中。
                    </p>

                    {/* Node selection & actions */}
                    {onlineNodes.length === 0 ? (
                      <div className="p-3 bg-white dark:bg-zinc-950 border border-dashed border-zinc-200 dark:border-zinc-800 rounded-xl text-center text-xs text-zinc-400 dark:text-zinc-500">
                        暂无在线的计算节点可执行本地登录，请先接入并保持节点在线。
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">操作目标节点:</span>
                          <select
                            aria-label="登录目标节点"
                            value={selectedNodeId}
                            onChange={(e) => handleNodeChange(e.target.value)}
                            className="px-2.5 py-1 text-xs bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-900 dark:focus:ring-zinc-400 font-medium text-zinc-800 dark:text-zinc-200"
                          >
                            <option value="" className="dark:bg-zinc-900 dark:text-zinc-100">请选择节点</option>
                            {onlineNodes.map((n) => (
                              <option key={n.id} value={n.id} className="dark:bg-zinc-900 dark:text-zinc-100">
                                {n.name} ({n.platform})
                              </option>
                            ))}
                          </select>
                        </div>

                        {/* Auth method buttons */}
                        <div className="flex flex-wrap gap-2 pt-1">
                          {selectedProvider.authMethods && selectedProvider.authMethods.length > 0 ? (
                            selectedProvider.authMethods
                              .filter((method) => method.interactive)
                              .map((method, mIdx) => (
                                <button
                                  key={mIdx}
                                  type="button"
                                  onClick={() => handleStartNodeLogin(selectedProvider, method)}
                                  className={`px-3 py-2 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors shadow-2xs ${
                                    method.type === 'oauth'
                                      ? 'bg-zinc-900 hover:bg-zinc-800 text-white dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white'
                                      : 'bg-white hover:bg-zinc-100 text-zinc-800 border border-zinc-200 dark:bg-zinc-900 dark:hover:bg-zinc-800 dark:text-zinc-200 dark:border-zinc-700'
                                  }`}
                                >
                                  {method.type === 'oauth' ? (
                                    <ExternalLink className="w-3.5 h-3.5" />
                                  ) : (
                                    <Key className="w-3.5 h-3.5 text-zinc-600 dark:text-zinc-400" />
                                  )}
                                  <span>
                                    {method.label ||
                                      (method.type === 'oauth' ? 'OAuth 授权登录' : '本地 API Key 配置')}
                                  </span>
                                  {method.subscription && (
                                    <span className="text-[11px] px-1 py-0.2 bg-zinc-200 dark:bg-zinc-800 text-zinc-800 dark:text-zinc-200 rounded font-medium">
                                      订阅
                                    </span>
                                  )}
                                </button>
                              ))
                          ) : (
                            <p className="text-xs text-zinc-500 dark:text-zinc-400">
                              该服务商未提供可交互的授权方式，请直接在所选节点上完成配置。
                            </p>
                          )}

                          {hasNodeCredential && (
                            <button
                              type="button"
                              onClick={() => handleClearNodeAuth(selectedProvider.id)}
                              disabled={clearingAuth}
                              className="px-3 py-2 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 border border-rose-200 dark:border-rose-900/60 rounded-xl text-xs font-semibold flex items-center gap-1.5 transition-colors"
                              title="清除该节点本地保存的凭据"
                            >
                              {clearingAuth ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <LogOut className="w-3.5 h-3.5" />
                              )}
                              <span>清除该节点凭据</span>
                            </button>
                          )}
                        </div>

                        <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
                          提示：模型服务凭据均以节点为单位配置与保存；部分第三方服务商 OAuth 需外部网络连通与账号授权。
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Section: SDK Models preview */}
                  <div className="space-y-2">
                    <span className="text-xs font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
                      <Cpu className="w-3.5 h-3.5 text-zinc-700 dark:text-zinc-300" />
                      <span>内置模型列表 ({selectedProvider.models?.length || 0})</span>
                    </span>

                    {selectedProvider.models && selectedProvider.models.length > 0 ? (
                      <div className="border border-zinc-200 dark:border-zinc-800 rounded-xl overflow-hidden max-h-56 overflow-y-auto bg-white dark:bg-zinc-950 shadow-2xs">
                        <table className="w-full text-left text-xs border-collapse">
                          <thead className="bg-zinc-50 dark:bg-zinc-900 text-zinc-600 dark:text-zinc-400 border-b border-zinc-200 dark:border-zinc-800 text-[11px]">
                            <tr>
                              <th className="px-3 py-2 font-semibold">模型型号</th>
                              <th className="px-3 py-2 font-semibold">名称</th>
                              <th className="px-3 py-2 font-semibold">推理能力</th>
                              <th className="px-3 py-2 font-semibold">上下文窗口</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
                            {selectedProvider.models.map((m) => (
                              <tr key={m.id} className="hover:bg-zinc-50/70 dark:hover:bg-zinc-900/70">
                                <td className="px-3 py-2 font-mono text-[11px] text-zinc-800 dark:text-zinc-200 font-medium">
                                  {m.id}
                                </td>
                                <td className="px-3 py-2 text-zinc-800 dark:text-zinc-200">{m.name}</td>
                                <td className="px-3 py-2">
                                  {m.reasoning ? (
                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 rounded text-[11px] font-medium">
                                      <Sparkles className="w-2.5 h-2.5" />
                                      <span>支持思考</span>
                                    </span>
                                  ) : (
                                    <span className="text-zinc-400 dark:text-zinc-500 text-[11px]">-</span>
                                  )}
                                </td>
                                <td className="px-3 py-2 text-zinc-500 dark:text-zinc-400 font-mono text-[11px]">
                                  {m.contextWindow ? `${Math.round(m.contextWindow / 1000)}k` : '-'}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="p-3 bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-xl text-xs text-zinc-500 dark:text-zinc-400">
                        该服务商当前没有可选的聊天模型。完成授权或在节点注册兼容模型后，刷新目录再选择。
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="py-20 text-center text-zinc-400 dark:text-zinc-500 text-xs">
                  请从左侧选择一个服务商以查看并编辑配置
                </div>
              )}
            </div>
          </div>

          {/* Modal Footer */}
          <div className="px-5 sm:px-6 py-3.5 border-t border-zinc-200/80 dark:border-zinc-800/80 bg-zinc-50/60 dark:bg-zinc-900/60 flex items-center justify-between shrink-0">
            <div className="text-[11px] text-zinc-500 dark:text-zinc-400 hidden sm:block">
              凭据仅保存在所选节点本地，清除后需重新授权
            </div>

            <div className="flex items-center gap-2 ml-auto">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-xl transition-colors"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Submodal: Node Native Auth Dialog */}
      {activeAuthTarget && (
        <ProviderAuthModal
          isOpen={Boolean(activeAuthTarget)}
          nodeId={activeAuthTarget.nodeId}
          nodeName={activeAuthTarget.nodeName}
          providerId={activeAuthTarget.providerId}
          providerName={activeAuthTarget.providerName}
          authMethod={activeAuthTarget.authMethod}
          onClose={() => setActiveAuthTarget(null)}
          onSuccess={async () => {
            setActiveAuthTarget(null);
            setSuccess(true);
            await fetchCatalog(selectedNodeId);
            setTimeout(() => setSuccess(false), 3000);
          }}
        />
      )}

      {/* Submodal: 清除节点凭据确认 */}
      <ConfirmDialog
        isOpen={Boolean(clearAuthProviderId)}
        title="清除节点凭据"
        message={
          <>
            确定要清除节点 “{selectedNode?.name || selectedNodeId}” 上的 {clearAuthProviderId} 专属凭据吗？
            <br />
            清除后该服务商需重新授权才能继续使用。
          </>
        }
        confirmText="清除凭据"
        danger
        busy={clearingAuth}
        onConfirm={confirmClearNodeAuth}
        onClose={() => setClearAuthProviderId(null)}
      />
    </>
  );
};
