import { useState, useMemo, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/page-header'
import { Input } from '@/components/ui/input'

// ── Types ──

interface ModelEntry {
  modelDbId: number
  priority: number
  effectivePriority: number
  penalty: number
  rateLimitHits: number
  enabled: boolean
  platform: string
  modelId: string
  displayName: string
  intelligenceRank: number
  speedRank: number
  sizeLabel: string
  rpmLimit: number | null
  rpdLimit: number | null
  monthlyTokenBudget: string
  keyCount: number
}

interface AvailableModel {
  id: number
  platform: string
  modelId: string
  displayName: string
  intelligenceRank: number
  speedRank: number
  sizeLabel: string
  rpmLimit: number | null
  rpdLimit: number | null
  monthlyTokenBudget: string
}

type Groups = Record<string, ModelEntry[]>

type GroupName = 'auto' | 'planning' | 'execution' | 'review'

interface TokenUsageData {
  totalBudget: number
  totalUsed: number
  models: { displayName: string; platform: string; budget: number }[]
}

const GROUP_NAMES: GroupName[] = ['auto', 'planning', 'execution', 'review']
const GROUP_LABELS: Record<GroupName, string> = {
  auto: 'Auto',
  planning: 'Planning',
  execution: 'Execution',
  review: 'Review',
}
const GROUP_DESCRIPTIONS: Record<GroupName, string> = {
  auto: 'Default group. Used when no specific group is requested.',
  planning: 'Models optimized for planning and structured thinking.',
  execution: 'Fast models optimized for code execution and generation.',
  review: 'Models with strong reasoning for code review and analysis.',
}

// ── Formatting helpers ──

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

const platformColors: Record<string, string> = {
  google:      '#4285f4',
  groq:        '#f55036',
  cerebras:    '#8b5cf6',
  sambanova:   '#14b8a6',
  nvidia:      '#76b900',
  mistral:     '#f59e0b',
  openrouter:  '#ec4899',
  github:      '#6e7b8b',
  huggingface: '#ffd21e',
  cohere:      '#d946ef',
  cloudflare:  '#f38020',
  zhipu:       '#06b6d4',
  moonshot:    '#4f46e5',
  minimax:     '#a855f7',
  opencode:    '#10b981',
  clod:        '#3b82f6',
  deepseek:    '#1d4ed8',
}

// ── Sub-components ──

function TokenUsageBar({ data }: { data: TokenUsageData }) {
  const { totalBudget, totalUsed, models } = data
  const remaining = Math.max(0, totalBudget - totalUsed)
  const remainingPct = totalBudget > 0 ? Math.round((remaining / totalBudget) * 100) : 0

  const modelsWithWidth = models.map(m => ({
    ...m,
    widthPct: totalBudget > 0 ? (m.budget / totalBudget) * (remaining / totalBudget) * 100 : 0,
  }))
  const usedPct = totalBudget > 0 ? (totalUsed / totalBudget) * 100 : 0

  return (
    <section className="rounded-lg border bg-card p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-medium">Monthly token budget</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          <span className="text-foreground font-medium">{formatTokens(remaining)}</span> remaining
          <span className="mx-1.5">·</span>
          {remainingPct}% of {formatTokens(totalBudget)}
        </span>
      </div>

      <div className="flex h-2.5 rounded-full overflow-hidden bg-muted">
        {modelsWithWidth.map((m, i) => (
          <div
            key={i}
            title={`${m.displayName} (${m.platform}) — ${formatTokens(m.budget)} remaining`}
            style={{
              width: `${Math.max(m.widthPct, 0.5)}%`,
              backgroundColor: platformColors[m.platform] ?? '#94a3b8',
            }}
          />
        ))}
        {totalUsed > 0 && (
          <div
            title={`Used — ${formatTokens(totalUsed)}`}
            className="bg-muted-foreground/30"
            style={{ width: `${usedPct}%` }}
          />
        )}
      </div>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-1.5 text-xs tabular-nums">
        {modelsWithWidth.map((m, i) => (
          <div key={i} className="flex items-center gap-2 min-w-0">
            <span
              className="size-2 rounded-sm flex-shrink-0"
              style={{ backgroundColor: platformColors[m.platform] ?? '#94a3b8' }}
            />
            <span className="truncate">{m.displayName}</span>
          </div>
        ))}
      </div>
    </section>
  )
}

interface SortableRowProps {
  entry: ModelEntry
  index: number
  onRemove: (modelDbId: number) => void
}

function SortableModelRow({ entry, index, onRemove }: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.modelDbId,
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`group flex items-center gap-3 px-4 py-3 bg-card ${isDragging ? 'opacity-50 z-10 shadow-lg' : ''}`}
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-muted-foreground/50 hover:text-foreground transition-colors"
        aria-label="Drag to reorder"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" />
          <circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" />
          <circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" />
        </svg>
      </button>
      <span className="text-xs font-mono text-muted-foreground w-5 tabular-nums">{index + 1}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm">{entry.displayName}</span>
          <span className="text-xs text-muted-foreground">{entry.platform}</span>
          {entry.penalty > 0 && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              −{entry.penalty} penalty
            </span>
          )}
        </div>
        <div className="flex gap-3 mt-0.5 text-xs text-muted-foreground tabular-nums">
          <span>Intel #{entry.intelligenceRank}</span>
          <span>Speed #{entry.speedRank}</span>
          {entry.rpmLimit && <span>{entry.rpmLimit} rpm</span>}
          {entry.rpdLimit && <span>{entry.rpdLimit} rpd</span>}
        </div>
      </div>
      <button
        onClick={() => onRemove(entry.modelDbId)}
        className="text-muted-foreground/40 hover:text-destructive transition-colors p-1"
        aria-label={`Remove ${entry.displayName}`}
        title="Remove from group"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  )
}

interface AddModelDialogProps {
  open: boolean
  group: GroupName | null
  allModels: AvailableModel[]
  onAdd: (modelDbId: number) => void
  onClose: () => void
}

function AddModelDialog({ open, group, allModels, onAdd, onClose }: AddModelDialogProps) {
  const [search, setSearch] = useState('')

  const filtered = useMemo(() => {
    if (!search.trim()) return allModels
    const q = search.toLowerCase()
    return allModels.filter(m =>
      m.displayName.toLowerCase().includes(q) ||
      m.platform.toLowerCase().includes(q) ||
      m.modelId.toLowerCase().includes(q)
    )
  }, [allModels, search])

  if (!open || !group) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Overlay */}
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      {/* Dialog */}
      <div className="relative bg-background border rounded-lg shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h2 className="text-base font-semibold">Add model to {GROUP_LABELS[group]}</h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="px-5 py-3 border-b">
          <Input
            placeholder="Search models..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">
              {search ? 'No models match your search.' : 'No models available.'}
            </p>
          ) : (
            <div className="divide-y">
              {filtered.map(m => (
                <button
                  key={m.id}
                  className="w-full text-left flex items-center gap-3 px-3 py-2.5 hover:bg-accent/50 rounded-sm transition-colors"
                  onClick={() => {
                    onAdd(m.id)
                    onClose()
                  }}
                >
                  <span
                    className="size-2.5 rounded-sm flex-shrink-0"
                    style={{ backgroundColor: platformColors[m.platform] ?? '#94a3b8' }}
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium">{m.displayName}</span>
                    <span className="text-xs text-muted-foreground ml-2">{m.platform}</span>
                  </div>
                  <div className="text-xs text-muted-foreground tabular-nums flex gap-2 flex-shrink-0">
                    <span>#{m.intelligenceRank}</span>
                    <span>#{m.speedRank}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Group Section ──

interface GroupSectionProps {
  group: GroupName
  entries: ModelEntry[]
  sensors: ReturnType<typeof useSensors>
  onDragEnd: (event: DragEndEvent) => void
  onRemove: (modelDbId: number) => void
  onAddModel: () => void
  onSort: (preset: string) => void
  isSorting: boolean
  hasChanges: boolean
  onSave: () => void
  onDiscard: () => void
  savePending: boolean
}

function GroupSection({
  group,
  entries,
  sensors,
  onDragEnd,
  onRemove,
  onAddModel,
  onSort,
  isSorting,
  hasChanges,
  onSave,
  onDiscard,
  savePending,
}: GroupSectionProps) {
  const modelIds = entries.map(e => e.modelDbId)

  return (
    <div className="rounded-lg border">
      {/* Group Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-muted/30 border-b">
        <div>
          <h3 className="text-sm font-semibold">
            {GROUP_LABELS[group]}
            <span className="text-muted-foreground font-normal ml-1.5">({entries.length})</span>
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">{GROUP_DESCRIPTIONS[group]}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => onSort('intelligence')} disabled={isSorting || entries.length < 2}>
            Sort intel
          </Button>
          <Button variant="outline" size="sm" onClick={() => onSort('speed')} disabled={isSorting || entries.length < 2}>
            Sort speed
          </Button>
          <Button variant="outline" size="sm" onClick={() => onSort('budget')} disabled={isSorting || entries.length < 2}>
            Sort budget
          </Button>
          <Button size="sm" onClick={onAddModel}>+ Add model</Button>
        </div>
      </div>

      {/* Model List */}
      {entries.length === 0 ? (
        <div className="px-4 py-8 text-center">
          <p className="text-sm text-muted-foreground">No models in this group.</p>
          <p className="text-xs text-muted-foreground mt-1">Click "+ Add model" to add models.</p>
        </div>
      ) : (
        <div className="divide-y">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={modelIds} strategy={verticalListSortingStrategy}>
              {entries.map((entry, index) => (
                <SortableModelRow
                  key={entry.modelDbId}
                  entry={entry}
                  index={index}
                  onRemove={onRemove}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      )}

      {/* Save/Discard when local changes exist */}
      {hasChanges && (
        <div className="flex justify-end gap-2 px-4 py-3 border-t bg-muted/10">
          <Button variant="outline" size="sm" onClick={onDiscard}>
            Discard
          </Button>
          <Button size="sm" onClick={onSave} disabled={savePending}>
            {savePending ? 'Saving…' : 'Save order'}
          </Button>
        </div>
      )}
    </div>
  )
}

// ── Main Page ──

export default function FallbackPage() {
  const queryClient = useQueryClient()

  // ── Server data ──
  const { data: groupsData, isLoading } = useQuery<Groups>({
    queryKey: ['fallback', 'groups'],
    queryFn: () => apiFetch('/api/fallback/groups'),
  })

  const { data: allModels } = useQuery<AvailableModel[]>({
    queryKey: ['fallback', 'models'],
    queryFn: () => apiFetch('/api/fallback/models'),
  })

  const { data: tokenUsage } = useQuery<TokenUsageData>({
    queryKey: ['fallback', 'token-usage'],
    queryFn: () => apiFetch('/api/fallback/token-usage'),
  })

  // ── Local drag state (per group) ──
  const [localGroups, setLocalGroups] = useState<Groups | null>(null)

  // ── Dialog state ──
  const [dialogGroup, setDialogGroup] = useState<GroupName | null>(null)

  // ── Sensors ──
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // ── Effective data ──
  const groups = localGroups ?? groupsData ?? { auto: [], planning: [], execution: [], review: [] }

  // ── Mutations ──

  const addMutation = useMutation({
    mutationFn: ({ group, modelDbIds }: { group: GroupName; modelDbIds: number[] }) =>
      apiFetch(`/api/fallback/group/${group}/models`, {
        method: 'POST',
        body: JSON.stringify({ modelDbIds }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback', 'groups'] })
      queryClient.invalidateQueries({ queryKey: ['fallback', 'token-usage'] })
      setLocalGroups(null)
    },
  })

  const removeMutation = useMutation({
    mutationFn: ({ group, modelDbId }: { group: GroupName; modelDbId: number }) =>
      apiFetch(`/api/fallback/group/${group}/models/${modelDbId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback', 'groups'] })
      setLocalGroups(null)
    },
  })

  const saveReorderMutation = useMutation({
    mutationFn: ({ group, entries }: { group: GroupName; entries: { modelDbId: number; priority: number }[] }) =>
      apiFetch(`/api/fallback/group/${group}`, {
        method: 'PUT',
        body: JSON.stringify(entries),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback', 'groups'] })
      setLocalGroups(null)
    },
  })

  const sortMutation = useMutation({
    mutationFn: ({ group, preset }: { group: GroupName; preset: string }) =>
      apiFetch(`/api/fallback/group/${group}/sort/${preset}`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback', 'groups'] })
      setLocalGroups(null)
    },
  })

  // ── Handlers ──

  const handleDragEnd = useCallback((group: GroupName) => (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const current = groups[group]
    const oldIndex = current.findIndex(e => e.modelDbId === active.id)
    const newIndex = current.findIndex(e => e.modelDbId === over.id)
    if (oldIndex === -1 || newIndex === -1) return

    const reordered = arrayMove(current, oldIndex, newIndex).map((e, i) => ({
      ...e,
      priority: i + 1,
    }))

    setLocalGroups(prev => ({
      ...(prev ?? groups),
      [group]: reordered,
    }))
  }, [groups])

  const handleRemove = useCallback((group: GroupName) => (modelDbId: number) => {
    removeMutation.mutate({ group, modelDbId })
  }, [removeMutation])

  const handleAddModel = useCallback((group: GroupName) => {
    setDialogGroup(group)
  }, [])

  const handleAddToGroup = useCallback((modelDbId: number) => {
    if (!dialogGroup) return
    addMutation.mutate({ group: dialogGroup, modelDbIds: [modelDbId] })
    setDialogGroup(null)
  }, [dialogGroup, addMutation])

  const handleCloseDialog = useCallback(() => {
    setDialogGroup(null)
  }, [])

  const handleSort = useCallback((group: GroupName) => (preset: string) => {
    sortMutation.mutate({ group, preset })
  }, [sortMutation])

  const handleSaveOrder = useCallback((group: GroupName) => () => {
    const entries = groups[group]
    if (!entries) return
    saveReorderMutation.mutate({
      group,
      entries: entries.map((e, i) => ({ modelDbId: e.modelDbId, priority: i + 1 })),
    })
  }, [groups, saveReorderMutation])

  const handleDiscard = useCallback((group: GroupName) => () => {
    setLocalGroups(prev => {
      if (!prev) return null
      const next = { ...prev }
      delete next[group]
      return Object.keys(next).length > 0 ? next : null
    })
  }, [])

  const hasChangesForGroup = useCallback((group: GroupName) => {
    if (!localGroups || !groupsData) return false
    const local = localGroups[group]
    const server = groupsData[group]
    if (!local || !server) return !!local
    if (local.length !== server.length) return true
    return local.some((e, i) => e.modelDbId !== server[i].modelDbId)
  }, [localGroups, groupsData])

  // ── Render ──

  return (
    <div>
      <PageHeader
        title="Fallback chain"
        description="Organize models into groups. Requests use the matching group's prioritized model list."
      />

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-6">
          {GROUP_NAMES.map(group => (
            <GroupSection
              key={group}
              group={group}
              entries={groups[group] ?? []}
              sensors={sensors}
              onDragEnd={handleDragEnd(group)}
              onRemove={handleRemove(group)}
              onAddModel={() => handleAddModel(group)}
              onSort={handleSort(group)}
              isSorting={sortMutation.isPending}
              hasChanges={hasChangesForGroup(group)}
              onSave={handleSaveOrder(group)}
              onDiscard={handleDiscard(group)}
              savePending={saveReorderMutation.isPending}
            />
          ))}

          {tokenUsage && tokenUsage.totalBudget > 0 && (
            <TokenUsageBar data={tokenUsage} />
          )}
        </div>
      )}

      {/* Add model dialog */}
      <AddModelDialog
        open={dialogGroup !== null}
        group={dialogGroup}
        allModels={allModels ?? []}
        onAdd={handleAddToGroup}
        onClose={handleCloseDialog}
      />
    </div>
  )
}
