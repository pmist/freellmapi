import { useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/page-header'
import type { ApiKey, Platform } from '../../../shared/types'

const PLATFORMS: { value: Platform; label: string }[] = [
  { value: 'google', label: 'Google AI Studio' },
  { value: 'groq', label: 'Groq' },
  { value: 'cerebras', label: 'Cerebras' },
  { value: 'sambanova', label: 'SambaNova' },
  { value: 'nvidia', label: 'NVIDIA NIM' },
  { value: 'mistral', label: 'Mistral' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'github', label: 'GitHub Models' },
  { value: 'huggingface', label: 'Hugging Face' },
  { value: 'cohere', label: 'Cohere' },
  { value: 'cloudflare', label: 'Cloudflare Workers AI' },
  { value: 'zhipu', label: 'Zhipu AI (Z.ai)' },
  { value: 'moonshot', label: 'Moonshot (Kimi)' },
  { value: 'minimax', label: 'MiniMax' },
  { value: 'opencode', label: 'OpenCode Zen' },
  { value: 'clod', label: 'CLōD' },
  { value: 'deepseek', label: 'DeepSeek' },
]

const statusDot: Record<string, string> = {
  healthy: 'bg-emerald-500',
  rate_limited: 'bg-amber-500',
  invalid: 'bg-rose-500',
  error: 'bg-rose-500',
  unknown: 'bg-muted-foreground/40',
}

const statusLabel: Record<string, string> = {
  healthy: 'healthy',
  rate_limited: 'rate-limited',
  invalid: 'invalid',
  error: 'error',
  unknown: 'unchecked',
}

interface HealthPlatform {
  platform: string
  totalKeys: number
  healthyKeys: number
  rateLimitedKeys: number
  invalidKeys: number
  errorKeys: number
  unknownKeys: number
}

interface HealthData {
  platforms: HealthPlatform[]
  keys: { id: number; platform: string; status: string; lastCheckedAt: string | null }[]
}

function UnifiedKeySection() {
  const queryClient = useQueryClient()
  const [showKey, setShowKey] = useState(false)
  const [copied, setCopied] = useState(false)

  const { data } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const regenerate = useMutation({
    mutationFn: () => apiFetch('/api/settings/api-key/regenerate', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['unified-key'] }),
  })

  const apiKey = data?.apiKey ?? ''
  const masked = apiKey ? apiKey.slice(0, 13) + '•'.repeat(32) : '…'

  function copy() {
    navigator.clipboard.writeText(apiKey)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <h2 className="text-sm font-medium">Your unified API key</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Use this as your OpenAI <code className="font-mono">api_key</code>; it authenticates requests to this proxy.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => regenerate.mutate()}
          disabled={regenerate.isPending}
        >
          Regenerate
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <code className="flex-1 font-mono text-xs bg-muted px-3 py-2 rounded-md select-all truncate tabular-nums">
          {showKey ? apiKey : masked}
        </code>
        <Button variant="outline" size="sm" onClick={() => setShowKey(!showKey)}>
          {showKey ? 'Hide' : 'Show'}
        </Button>
        <Button variant="outline" size="sm" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      <div className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        <span className="text-muted-foreground">Base URL</span>
        <code className="font-mono">http://localhost:3001/v1</code>
        <span className="text-muted-foreground">Endpoint</span>
        <code className="font-mono">/v1/chat/completions</code>
      </div>
    </section>
  )
}

function SyncModelsModal({
  keyId, platform, onClose, onImported
}: {
  keyId: number, platform: string, onClose: () => void, onImported: () => void
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  const { data: models, isLoading, error } = useQuery<{id: string, name: string}[]>({
    queryKey: ['sync-models', keyId],
    queryFn: () => apiFetch(`/api/keys/${keyId}/models`),
  })

  const importMutation = useMutation({
    mutationFn: (modelsToImport: {id: string, name: string}[]) =>
      apiFetch(`/api/keys/${keyId}/models/import`, {
        method: 'POST',
        body: JSON.stringify({ models: modelsToImport })
      }),
    onSuccess: () => {
      onImported()
      onClose()
    }
  })

  const handleToggle = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  const handleImport = () => {
    if (!models) return
    const toImport = models.filter(m => selectedIds.has(m.id))
    importMutation.mutate(toImport)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-card border rounded-lg shadow-lg flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-sm font-medium">Sync Models ({platform})</h2>
          <Button variant="ghost" size="icon" className="size-6 text-muted-foreground" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        
        <div className="flex-1 overflow-auto p-4 space-y-3">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Fetching models from provider...</p>
          ) : error ? (
            <p className="text-sm text-destructive">Failed to fetch models.</p>
          ) : models && models.length === 0 ? (
            <p className="text-sm text-muted-foreground">No models found or syncing not supported for this provider.</p>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between mb-2 pb-2 border-b">
                <span className="text-xs text-muted-foreground">{models?.length} models found</span>
                <Button 
                  variant="ghost" 
                  size="sm" 
                  className="h-7 text-xs px-2"
                  onClick={() => {
                    if (selectedIds.size === models?.length) setSelectedIds(new Set())
                    else setSelectedIds(new Set(models?.map(m => m.id)))
                  }}
                >
                  {selectedIds.size === models?.length ? 'Deselect All' : 'Select All'}
                </Button>
              </div>
              {models?.map(m => (
                <label key={m.id} className="flex items-center gap-3 p-2 rounded hover:bg-muted cursor-pointer border border-transparent hover:border-border transition-colors">
                  <input 
                    type="checkbox" 
                    checked={selectedIds.has(m.id)}
                    onChange={() => handleToggle(m.id)}
                    className="accent-primary size-4"
                  />
                  <div className="flex flex-col">
                    <span className="text-sm font-medium">{m.name}</span>
                    <span className="text-[10px] text-muted-foreground font-mono leading-tight">{m.id}</span>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>
        
        <div className="p-4 border-t flex justify-end gap-2 bg-muted/20">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button 
            size="sm" 
            onClick={handleImport} 
            disabled={selectedIds.size === 0 || importMutation.isPending}
          >
            {importMutation.isPending ? 'Importing...' : `Import ${selectedIds.size} Models`}
          </Button>
        </div>
      </div>
    </div>
  )
}


function SyncAllModelsModal({
  onClose, onImported
}: {
  onClose: () => void, onImported: () => void
}) {
  const [selected, setSelected] = useState<Record<string, Set<string>>>({})

  const { data: results, isLoading, error } = useQuery<{keyId: number, platform: string, models: Array<{id: string, name: string}>}[]>({
    queryKey: ['sync-models-all'],
    queryFn: () => apiFetch('/api/keys/sync/all'),
  })

  const importMutation = useMutation({
    mutationFn: (items: {platform: string, models: Array<{id: string, name: string}>}[]) =>
      apiFetch('/api/keys/sync/import-bulk', {
        method: 'POST',
        body: JSON.stringify({ items })
      }),
    onSuccess: () => {
      onImported()
      onClose()
    }
  })

  const handleToggle = (platform: string, modelId: string) => {
    const next = { ...selected }
    if (!next[platform]) next[platform] = new Set()
    if (next[platform].has(modelId)) next[platform].delete(modelId)
    else next[platform].add(modelId)
    setSelected(next)
  }

  const handleToggleAll = (platform: string, models: {id: string}[]) => {
    const next = { ...selected }
    const platformSet = new Set(next[platform] || [])
    if (platformSet.size === models.length) {
      next[platform] = new Set()
    } else {
      next[platform] = new Set(models.map(m => m.id))
    }
    setSelected(next)
  }

  const handleImport = () => {
    if (!results) return
    const items = results.map(r => ({
      platform: r.platform,
      models: r.models.filter(m => selected[r.platform]?.has(m.id))
    })).filter(i => i.models.length > 0)
    
    importMutation.mutate(items)
  }

  const totalSelected = Object.values(selected).reduce((acc, set) => acc + set.size, 0)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl bg-card border rounded-lg shadow-lg flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-sm font-medium">Sync All Models</h2>
          <Button variant="ghost" size="icon" className="size-6 text-muted-foreground" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        
        <div className="flex-1 overflow-auto p-4 space-y-6">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Discovering models across all providers...</p>
          ) : error ? (
            <p className="text-sm text-destructive">Failed to fetch models from providers.</p>
          ) : !results || results.length === 0 ? (
            <p className="text-sm text-muted-foreground">No new models discovered from enabled keys.</p>
          ) : (
            <div className="space-y-6">
              {results.map(res => (
                <div key={res.keyId} className="space-y-2">
                  <div className="flex items-center justify-between pb-1 border-b">
                    <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{res.platform}</span>
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="h-6 text-[10px] px-2"
                      onClick={() => handleToggleAll(res.platform, res.models)}
                    >
                      {selected[res.platform]?.size === res.models.length ? 'Deselect Platform' : 'Select Platform'}
                    </Button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {res.models.map(m => (
                      <label key={m.id} className="flex items-center gap-3 p-2 rounded hover:bg-muted cursor-pointer border border-transparent hover:border-border transition-colors">
                        <input 
                          type="checkbox" 
                          checked={selected[res.platform]?.has(m.id) || false}
                          onChange={() => handleToggle(res.platform, m.id)}
                          className="accent-primary size-4"
                        />
                        <div className="flex flex-col overflow-hidden">
                          <span className="text-xs font-medium truncate">{m.name}</span>
                          <span className="text-[10px] text-muted-foreground font-mono truncate">{m.id}</span>
                        </div>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        
        <div className="p-4 border-t flex justify-end gap-2 bg-muted/20">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button 
            size="sm" 
            onClick={handleImport} 
            disabled={totalSelected === 0 || importMutation.isPending}
          >
            {importMutation.isPending ? 'Importing...' : `Import ${totalSelected} Models`}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default function KeysPage() {
  const queryClient = useQueryClient()
  const [platform, setPlatform] = useState<Platform | ''>('')
  const [apiKey, setApiKey] = useState('')
  const [accountId, setAccountId] = useState('')
  const [label, setLabel] = useState('')
  const [syncModalState, setSyncModalState] = useState<{ id: number; platform: string } | null>(null)
  const [syncAllOpen, setSyncAllOpen] = useState(false)

  const { data: keys = [], isLoading } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })

  const { data: healthData } = useQuery<HealthData>({
    queryKey: ['health'],
    queryFn: () => apiFetch('/api/health'),
    refetchInterval: 30000,
  })

  const addKey = useMutation({
    mutationFn: (body: { platform: string; key: string; label?: string }) =>
      apiFetch('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setPlatform('')
      setApiKey('')
      setAccountId('')
      setLabel('')
    },
  })

  const deleteKey = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/keys/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
    },
  })

  const checkAll = useMutation({
    mutationFn: () => apiFetch('/api/health/check-all', { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  const checkKey = useMutation({
    mutationFn: (keyId: number) => apiFetch(`/api/health/check/${keyId}`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  const needsAccountId = platform === 'cloudflare'

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!platform || !apiKey) return
    if (needsAccountId && !accountId) return
    const key = needsAccountId ? `${accountId}:${apiKey}` : apiKey
    addKey.mutate({ platform, key, label: label || undefined })
  }

  const healthKeyMap = new Map<number, { status: string; lastCheckedAt: string | null }>()
  for (const k of healthData?.keys ?? []) healthKeyMap.set(k.id, k)

  const grouped = PLATFORMS.map(p => ({
    ...p,
    keys: keys.filter(k => k.platform === p.value),
  })).filter(p => p.keys.length > 0)

  return (
    <div>
      <PageHeader
        title="Keys"
        description="Provider credentials and the unified API key your apps connect with."
        actions={
          keys.length > 0 && (
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setSyncAllOpen(true)}>
                <RefreshCw className="size-3 mr-2" />
                Sync all
              </Button>
              <Button variant="outline" size="sm" onClick={() => checkAll.mutate()} disabled={checkAll.isPending}>
                {checkAll.isPending ? 'Checking…' : 'Check all'}
              </Button>
            </div>
          )
        }
      />

      <div className="space-y-8">
        <UnifiedKeySection />

        <section>
          <h2 className="text-sm font-medium mb-3">Add a provider key</h2>
          <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3 rounded-lg border p-4 bg-card">
            <div className="space-y-1.5">
              <Label className="text-xs">Platform</Label>
              <Select value={platform} onValueChange={(v) => setPlatform(v as Platform)}>
                <SelectTrigger className="w-[220px]">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map(p => (
                    <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {needsAccountId && (
              <div className="space-y-1.5">
                <Label className="text-xs">Account ID</Label>
                <Input
                  value={accountId}
                  onChange={e => setAccountId(e.target.value)}
                  placeholder="a1b2c3d4…"
                  className="w-[200px] font-mono text-xs"
                />
              </div>
            )}
            <div className="space-y-1.5 flex-1 min-w-[240px]">
              <Label className="text-xs">{needsAccountId ? 'API token' : 'API key'}</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={needsAccountId ? 'Bearer token' : 'paste key here'}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Label</Label>
              <Input
                value={label}
                onChange={e => setLabel(e.target.value)}
                placeholder="optional"
                className="w-[160px]"
              />
            </div>
            <Button type="submit" size="sm" disabled={!platform || !apiKey || (needsAccountId && !accountId) || addKey.isPending}>
              {addKey.isPending ? 'Adding…' : 'Add key'}
            </Button>
          </form>
          {addKey.isError && (
            <p className="text-destructive text-xs mt-2">{(addKey.error as Error).message}</p>
          )}
        </section>

        <section>
          <h2 className="text-sm font-medium mb-3">Configured providers</h2>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : keys.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <p className="text-sm text-muted-foreground">
                No provider keys yet. Add one above to start routing.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              {grouped.map(group => (
                <div key={group.value}>
                  <div className="flex items-baseline justify-between mb-2">
                    <h3 className="text-sm font-medium">{group.label}</h3>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {group.keys.length} key{group.keys.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div className="rounded-lg border divide-y bg-card overflow-hidden">
                    {group.keys.map(k => {
                      const h = healthKeyMap.get(k.id)
                      const status = h?.status ?? k.status
                      const lastChecked = h?.lastCheckedAt
                      return (
                        <div key={k.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
                          <span className={`size-1.5 rounded-full flex-shrink-0 ${statusDot[status] ?? statusDot.unknown}`} />
                          <code className="text-xs font-mono flex-shrink-0">{k.maskedKey}</code>
                          {k.label && <span className="text-xs text-muted-foreground">{k.label}</span>}
                          <span className="text-xs text-muted-foreground">{statusLabel[status] ?? status}</span>
                          <div className="flex-1" />
                          {lastChecked && (
                            <span className="text-[11px] text-muted-foreground tabular-nums">
                              {new Date(lastChecked).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          )}
                          <Button variant="ghost" size="xs" onClick={() => checkKey.mutate(k.id)} disabled={checkKey.isPending}>
                            Check
                          </Button>
                          <Button variant="ghost" size="xs" onClick={() => setSyncModalState({ id: k.id, platform: group.label })}>
                            <RefreshCw className="size-3 mr-1" />
                            Sync
                          </Button>
                          <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-destructive" onClick={() => deleteKey.mutate(k.id)} disabled={deleteKey.isPending}>
                            Remove
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {syncModalState && (
        <SyncModelsModal
          keyId={syncModalState.id}
          platform={syncModalState.platform}
          onClose={() => setSyncModalState(null)}
          onImported={() => {
            queryClient.invalidateQueries({ queryKey: ['fallback'] })
            queryClient.invalidateQueries({ queryKey: ['keys'] })
          }}
        />
      )}

      {syncAllOpen && (
        <SyncAllModelsModal
          onClose={() => setSyncAllOpen(false)}
          onImported={() => {
            queryClient.invalidateQueries({ queryKey: ['fallback'] })
            queryClient.invalidateQueries({ queryKey: ['keys'] })
          }}
        />
      )}
    </div>
  )
}
