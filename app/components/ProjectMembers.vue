<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui/runtime/components/DropdownMenu.vue'
import type { Member } from '~/types/card'

interface ProjectMember extends Member {
  role: 'owner' | 'member'
  /** Agents only: how many cards it holds here, which removing it unassigns. */
  assignedCardCount?: number | null
  /** Sent to owners and admins only: removing an admin keeps their agents here. */
  isAdmin?: boolean
}

interface ProjectInvitation {
  id: string
  email: string
}

interface SearchUser {
  id: string
  name: string
  avatarUrl?: string | null
  kind?: 'human' | 'agent'
}

const props = defineProps<{
  projectId: string
  /** For the remove confirmation: "leave Completo with him". */
  projectName?: string
}>()

const { user: currentUser } = useUserSession()
const toast = useToast()

const { data: members, refresh } = useFetch<ProjectMember[]>(`/api/projects/${props.projectId}/members`)

/** People only: agents have their own section below them. */
const sortedMembers = computed(() => {
  return [...(members.value || [])].filter(m => !isAgent(m)).sort((a, b) =>
    (a.name || '').localeCompare(b.name || '')
  )
})

const isOwnerOrAdmin = computed(() => {
  if (currentUser.value?.isAdmin) return true
  const memberList = members.value || []
  const me = memberList.find(m => m.id === currentUser.value?.id)
  return me?.role === 'owner'
})

// Pending invitations
const { data: invitations, refresh: refreshInvitations } = useFetch<ProjectInvitation[]>(`/api/projects/${props.projectId}/invitations`, {
  immediate: false
})

watch(isOwnerOrAdmin, (val) => {
  if (val) refreshInvitations()
}, { immediate: true })

const cancellingInvitation = ref<string | null>(null)
const resendingInvitation = ref<string | null>(null)

async function resendInvitation(invitationId: string) {
  resendingInvitation.value = invitationId
  try {
    await $fetch(`/api/projects/${props.projectId}/invitations/${invitationId}/resend`, {
      method: 'POST'
    })
    toast.add({ title: 'Invitation resent', color: 'success' })
  } catch (e: unknown) {
    const err = e as { data?: { message?: string } }
    toast.add({ title: 'Failed to resend invitation', description: err?.data?.message, color: 'error' })
  } finally {
    resendingInvitation.value = null
  }
}

async function cancelInvitation(invitationId: string) {
  cancellingInvitation.value = invitationId
  try {
    await $fetch(`/api/projects/${props.projectId}/invitations/${invitationId}`, {
      method: 'DELETE'
    })
    await refreshInvitations()
    toast.add({ title: 'Invitation cancelled', color: 'success' })
  } catch (e: unknown) {
    const err = e as { data?: { message?: string } }
    toast.add({ title: 'Failed to cancel invitation', description: err?.data?.message, color: 'error' })
  } finally {
    cancellingInvitation.value = null
  }
}

// Add member — search-based
const searchQuery = ref('')
const searchResults = ref<SearchUser[]>([])
const searching = ref(false)
const addError = ref('')
const adding = ref(false)
const showResults = ref(false)
const highlightIndex = ref(-1)
let searchTimeout: ReturnType<typeof setTimeout> | null = null

function isValidEmail(str: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)
}

watch(searchQuery, (val) => {
  addError.value = ''
  highlightIndex.value = -1
  if (searchTimeout) clearTimeout(searchTimeout)
  const q = val.trim()
  if (q.length < 2) {
    searchResults.value = []
    showResults.value = false
    return
  }
  searching.value = true
  showResults.value = true
  searchTimeout = setTimeout(async () => {
    try {
      const results = await $fetch<SearchUser[]>('/api/users/search', { params: { q } })
      if (searchQuery.value.trim() === q) {
        const memberIds = new Set((members.value || []).map(m => m.id))
        // Agents join through "Add agent", which only offers the ones allowed here.
        searchResults.value = results.filter(u => !memberIds.has(u.id) && !isAgent(u))
      }
    } catch {
      searchResults.value = []
    } finally {
      searching.value = false
    }
  }, 200)
})

async function addMember(user: SearchUser) {
  adding.value = true
  addError.value = ''
  try {
    await $fetch(`/api/projects/${props.projectId}/members`, {
      method: 'POST',
      body: { userId: user.id }
    })
    searchQuery.value = ''
    searchResults.value = []
    showResults.value = false
    await refresh()
    toast.add({ title: `${user.name} added to project`, color: 'success' })
  } catch (e: unknown) {
    const err = e as { data?: { message?: string } }
    addError.value = err?.data?.message || 'Failed to add member'
  } finally {
    adding.value = false
  }
}

async function inviteByEmail() {
  const emailVal = searchQuery.value.trim()
  if (!isValidEmail(emailVal)) return
  adding.value = true
  addError.value = ''
  try {
    await $fetch(`/api/projects/${props.projectId}/members`, {
      method: 'POST',
      body: { email: emailVal }
    })
    searchQuery.value = ''
    searchResults.value = []
    showResults.value = false
    toast.add({ title: `Added or invited ${emailVal}`, color: 'success' })
    await refresh()
    await refreshInvitations()
  } catch (e: unknown) {
    const err = e as { data?: { message?: string } }
    addError.value = err?.data?.message || 'Failed to invite user'
  } finally {
    adding.value = false
  }
}

function onInputBlur() {
  setTimeout(() => {
    showResults.value = false
    highlightIndex.value = -1
  }, 200)
}

function onInputKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    // If a search result is highlighted, add that user
    if (showResults.value && highlightIndex.value >= 0 && highlightIndex.value < searchResults.value.length) {
      const selected = searchResults.value[highlightIndex.value]
      if (selected) addMember(selected)
      return
    }
    // If no results and looks like an email, invite
    if (searchResults.value.length === 0 && isValidEmail(searchQuery.value.trim())) {
      inviteByEmail()
      return
    }
  }
  if (!showResults.value || searchResults.value.length === 0) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    highlightIndex.value = (highlightIndex.value + 1) % searchResults.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    highlightIndex.value = highlightIndex.value <= 0
      ? searchResults.value.length - 1
      : highlightIndex.value - 1
  } else if (e.key === 'Escape') {
    showResults.value = false
    highlightIndex.value = -1
  }
}

// Change role
const changingRole = ref<string | null>(null)

const ownerCount = computed(() => {
  return (members.value || []).filter(m => m.role === 'owner').length
})

function canChangeRole(m: ProjectMember): boolean {
  if (!isOwnerOrAdmin.value) return false
  // Prevent demoting the last owner
  if (m.role === 'owner' && ownerCount.value <= 1) return false
  return true
}

async function changeRole(m: ProjectMember, newRole: 'owner' | 'member') {
  if (newRole === m.role) return
  changingRole.value = m.id
  try {
    await $fetch(`/api/projects/${props.projectId}/members/${m.id}`, {
      method: 'PATCH',
      body: { role: newRole }
    })
    await refresh()
    toast.add({ title: `${m.name} is now ${newRole === 'owner' ? 'an owner' : 'a member'}`, color: 'success' })
  } catch (e: unknown) {
    const err = e as { data?: { message?: string } }
    toast.add({ title: 'Failed to change role', description: err?.data?.message, color: 'error' })
  } finally {
    changingRole.value = null
  }
}

function roleMenuItems(m: ProjectMember): DropdownMenuItem[][] {
  const canRemove = !(m.role === 'owner' && m.id === currentUser.value?.id)
  const roleAction: DropdownMenuItem = m.role === 'member'
    ? { label: 'Promote to owner', icon: 'i-lucide-shield', onSelect: () => changeRole(m, 'owner') }
    : { label: 'Demote to member', icon: 'i-lucide-user', onSelect: () => changeRole(m, 'member') }
  const items: DropdownMenuItem[][] = [[roleAction]]
  if (canRemove) {
    items.push([{
      label: 'Remove from project',
      icon: 'i-lucide-user-minus',
      color: 'error',
      onSelect: () => removeMember(m)
    }])
  }
  return items
}

// Remove member
const removing = ref<string | null>(null)
const pendingRemove = ref<ProjectMember | null>(null)

/**
 * `UiConfirmDialog` takes a boolean, and what this actually has is the member it
 * is asking about — the dialog needs the name, so the target has to outlive the
 * flag. Writable so the dialog can close itself; clearing the target is what
 * closes it, which keeps one source rather than a flag that can disagree.
 */
const confirmingRemove = computed({
  get: () => !!pendingRemove.value,
  set: (open: boolean) => { if (!open) pendingRemove.value = null }
})

function removeMember(m: ProjectMember) {
  pendingRemove.value = m
}

/**
 * What removing `pendingRemove` takes with it. A person's agents can only be in
 * projects that person is in, so they leave too and their cards here are
 * unassigned; an agent's own cards are unassigned when it leaves. An admin's
 * agents are the exception and stay, since an admin reaches every project.
 */
const removeConsequences = computed(() => {
  const m = pendingRemove.value
  if (!m) return { agents: [] as ProjectMember[], cards: 0 }
  const agents = isAgent(m) || m.isAdmin ? [] : agentMembers.value.filter(a => a.managedBy?.id === m.id)
  const cards = isAgent(m)
    ? m.assignedCardCount ?? 0
    : agents.reduce((n, a) => n + (a.assignedCardCount ?? 0), 0)
  return { agents, cards }
})
const showRemovedAgents = ref(false)
watch(pendingRemove, () => {
  showRemovedAgents.value = false
})

const removeDescription = computed(() => {
  const m = pendingRemove.value
  if (m && isAgent(m)) return 'It loses access to this project. Its comments and uploads stay.'
  return 'They lose access to this project and are notified. Cards assigned to them keep their name.'
})

async function confirmRemoveMember() {
  const m = pendingRemove.value
  if (!m) return
  removing.value = m.id
  pendingRemove.value = null
  try {
    const result = await $fetch<{ removedAgents?: Array<{ id: string, name: string }>, unassignedCards?: number }>(`/api/projects/${props.projectId}/members/${m.id}`, {
      method: 'DELETE'
    })
    await refresh()
    const left = result?.removedAgents?.length ?? 0
    const unassigned = result?.unassignedCards ?? 0
    const details = [
      left ? `${plural(left, 'agent')} left with them.` : '',
      unassigned ? `${plural(unassigned, 'card')} unassigned.` : ''
    ].filter(Boolean).join(' ')
    toast.add({ title: `${m.name} removed from project`, description: details || undefined, color: 'success' })
  } catch (e: unknown) {
    const err = e as { data?: { message?: string } }
    toast.add({ title: 'Failed to remove member', description: err?.data?.message, color: 'error' })
  } finally {
    removing.value = null
  }
}

// ─── Agents ──────────────────────────────────────────────────────────────────
/**
 * Agents get their own section under the people, sorted by manager so one
 * person's agents sit together, each row carrying its manager's avatar. No chip
 * on the rows: the section label already says what they are. Their role is
 * locked to Member, so the pill shows a lock and its menu offers only Remove:
 * to owners and admins, and to the agent's own manager, who may take their agent
 * out of a project they are only a member of.
 */
const agentMembers = computed(() => [...(members.value || [])]
  .filter(m => isAgent(m))
  .sort((a, b) => (a.managedBy?.name ?? '').localeCompare(b.managedBy?.name ?? '') || a.name.localeCompare(b.name)))

const AGENTS_SHOWN = 5
const agentsOpen = ref(true)
const showAllAgents = ref(false)
const visibleAgents = computed(() => showAllAgents.value ? agentMembers.value : agentMembers.value.slice(0, AGENTS_SHOWN))

/** Whoever can add members can add agents: the project owner, and admins through their synthetic role. */
const canAddAgents = computed(() => isOwnerOrAdmin.value)
const showAgentsSection = computed(() => agentMembers.value.length > 0 || canAddAgents.value)

function canRemoveAgent(a: ProjectMember) {
  return isOwnerOrAdmin.value || a.managedBy?.id === currentUser.value?.id
}

function agentMenuItems(a: ProjectMember): DropdownMenuItem[][] {
  return [
    [
      { label: 'Owner', icon: 'i-lucide-shield', description: 'Agents can\'t own projects', disabled: true },
      { label: 'Member', icon: 'i-lucide-user', type: 'checkbox', checked: true }
    ],
    [{
      label: 'Remove from project',
      icon: 'i-lucide-user-minus',
      color: 'error',
      onSelect: () => removeMember(a)
    }]
  ]
}

/**
 * "Add agent": search-first, grouped by manager. The server lists only agents
 * that may join (active, not already here, and managed by someone who is a
 * member, or an admin) so the picker never offers one the add would refuse.
 */
interface AgentCandidate extends Member {
  description: string | null
}

const addAgentOpen = ref(false)
const agentQuery = ref('')
const candidates = ref<AgentCandidate[]>([])
const loadingCandidates = ref(false)
const expandedManagers = ref(new Set<string>())
const PER_MANAGER = 3

watch(addAgentOpen, async (isOpen) => {
  if (!isOpen) return
  agentQuery.value = ''
  expandedManagers.value = new Set()
  loadingCandidates.value = true
  try {
    candidates.value = await $fetch<AgentCandidate[]>(`/api/projects/${props.projectId}/agent-candidates`)
  } catch (e: unknown) {
    candidates.value = []
    toast.add({ title: 'Failed to load agents', description: getErrorMessage(e, 'Unknown error'), color: 'error' })
  } finally {
    loadingCandidates.value = false
  }
})

const candidateGroups = computed(() => {
  const q = agentQuery.value.trim()
  const groups = groupByManager(filterAgents(candidates.value, { query: q }), currentUser.value?.id)
  return groups.map(g => ({
    ...g,
    shown: q || expandedManagers.value.has(g.key) ? g.agents : g.agents.slice(0, PER_MANAGER)
  }))
})

function expandManager(key: string) {
  expandedManagers.value = new Set(expandedManagers.value).add(key)
}

const addingAgent = ref<string | null>(null)

async function addAgent(agent: AgentCandidate) {
  addingAgent.value = agent.id
  try {
    await $fetch(`/api/projects/${props.projectId}/members`, {
      method: 'POST',
      body: { userId: agent.id }
    })
    addAgentOpen.value = false
    agentsOpen.value = true
    await refresh()
    toast.add({ title: `${agent.name} added to project`, color: 'success' })
  } catch (e: unknown) {
    toast.add({ title: 'Failed to add agent', description: getErrorMessage(e, 'Unknown error'), color: 'error' })
  } finally {
    addingAgent.value = null
  }
}

// Invitation dropdown items
function invitationMenuItems(inv: ProjectInvitation): DropdownMenuItem[][] {
  return [
    [{
      label: 'Resend invitation',
      icon: 'i-lucide-refresh-cw',
      onSelect: () => resendInvitation(inv.id)
    }],
    [{
      label: 'Cancel invitation',
      icon: 'i-lucide-x',
      color: 'error',
      onSelect: () => cancelInvitation(inv.id)
    }]
  ]
}
</script>

<template>
  <div>
    <div class="rounded-xl border border-default">
      <div
        v-for="(m, mIdx) in (sortedMembers)"
        :key="m.id"
        class="flex items-center gap-2 px-3 py-2 transition-colors group"
        :class="[
          mIdx % 2 === 0 ? 'bg-default' : 'bg-muted',
          mIdx === 0 ? 'rounded-t-xl' : '',
          mIdx === (sortedMembers).length - 1 && !showAgentsSection ? 'rounded-b-xl' : ''
        ]"
      >
        <UiAvatar
          :src="m.avatarUrl ?? undefined"
          :alt="m.name"
          :kind="m.kind"
          :color="m.color"
          size="xs"
        />
        <span class="text-base font-medium flex-1 truncate">
          {{ m.name }}
          <span
            v-if="m.id === currentUser?.id"
            class="text-xs text-dimmed font-normal"
          >(you)</span>
        </span>
        <UDropdownMenu
          v-if="canChangeRole(m)"
          :items="roleMenuItems(m)"
        >
          <button
            type="button"
            class="text-2xs font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full shrink-0 cursor-pointer transition hover:ring-2 hover:ring-primary/20 flex items-center gap-1"
            :class="m.role === 'owner'
              ? 'bg-primary/10 text-primary'
              : 'bg-elevated text-muted'"
            :disabled="changingRole === m.id"
          >
            <UIcon
              v-if="changingRole === m.id"
              name="i-lucide-loader-2"
              class="text-2xs animate-spin"
            />
            <template v-else>
              {{ m.role }}
              <UIcon
                name="i-lucide-chevron-down"
                class="text-2xs opacity-60"
              />
            </template>
          </button>
        </UDropdownMenu>
        <span
          v-else
          class="text-2xs font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full shrink-0"
          :class="m.role === 'owner'
            ? 'bg-primary/10 text-primary'
            : 'bg-elevated text-muted'"
        >
          {{ m.role }}
        </span>
      </div>

      <!-- Agents, under the people. Collapsible, because a project can carry a
           team's worth of them and the people are what this list is mostly for. -->
      <div
        v-if="showAgentsSection"
        class="border-t border-default"
      >
        <div
          class="flex items-center gap-1.5 bg-default px-3 py-2"
          :class="!isOwnerOrAdmin && !agentsOpen ? 'rounded-b-xl' : ''"
        >
          <button
            type="button"
            class="flex items-center gap-1.5 min-w-0"
            :aria-expanded="agentsOpen"
            @click="agentsOpen = !agentsOpen"
          >
            <UIcon
              name="i-lucide-chevron-down"
              class="text-sm text-dimmed transition-transform duration-150"
              :class="agentsOpen ? '' : '-rotate-90'"
            />
            <UIcon
              name="i-lucide-bot"
              class="text-sm text-dimmed"
            />
            <span class="text-2xs font-bold text-dimmed uppercase tracking-label">Agents</span>
            <span class="text-xs font-mono tabular-nums text-dimmed">{{ agentMembers.length }}</span>
          </button>

          <UPopover
            v-if="canAddAgents"
            v-model:open="addAgentOpen"
            :content="{ align: 'end' }"
          >
            <UButton
              label="Add agent"
              icon="i-lucide-plus"
              size="xs"
              color="neutral"
              variant="soft"
              class="ml-auto"
            />

            <template #content>
              <div class="w-80">
                <!-- The shell owns the edge, so focus colours it; the input has no
                     border of its own. Same arrangement as MentionPicker. -->
                <div class="relative border-b border-default focus-within:border-primary">
                  <UIcon
                    name="i-lucide-search"
                    class="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-dimmed"
                  />
                  <input
                    v-model="agentQuery"
                    type="text"
                    aria-label="Search agents"
                    placeholder="Search agents"
                    autofocus
                    class="w-full pl-8 pr-3 py-2 text-sm text-default placeholder:text-dimmed bg-transparent border-0"
                  >
                </div>

                <div class="max-h-80 overflow-y-auto thin-scroll p-1">
                  <p
                    v-if="loadingCandidates"
                    class="px-2 py-3 text-xs text-dimmed text-center"
                  >
                    Loading agents…
                  </p>
                  <p
                    v-else-if="!candidateGroups.length"
                    class="px-2 py-3 text-xs text-dimmed text-center"
                  >
                    {{ agentQuery.trim() ? 'No agent matches' : 'No agent can join this project yet' }}
                  </p>
                  <div
                    v-for="g in candidateGroups"
                    v-else
                    :key="g.key"
                  >
                    <div class="flex items-center gap-1.5 px-2 pt-2 pb-1 text-xs">
                      <UiAvatar
                        v-if="g.manager"
                        :src="g.manager.avatarUrl"
                        :alt="g.manager.name"
                        size="3xs"
                      />
                      <span class="font-semibold text-muted truncate">{{ g.manager?.name ?? 'No manager' }}</span>
                      <span
                        v-if="g.isYou"
                        class="text-dimmed shrink-0"
                      >(you)</span>
                      <span class="ml-auto font-mono tabular-nums text-dimmed">{{ g.agents.length }}</span>
                    </div>
                    <button
                      v-for="a in g.shown"
                      :key="a.id"
                      type="button"
                      class="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-left text-sm text-default hover:bg-elevated transition-colors"
                      :disabled="addingAgent === a.id"
                      @click="addAgent(a)"
                    >
                      <UiAvatar
                        :alt="a.name"
                        kind="agent"
                        :color="a.color"
                        size="3xs"
                        class="shrink-0"
                      />
                      <span class="font-medium truncate">{{ a.name }}</span>
                      <span class="ml-auto text-xs text-dimmed truncate max-w-40">{{ a.description }}</span>
                    </button>
                    <button
                      v-if="g.shown.length < g.agents.length"
                      type="button"
                      class="w-full px-2 py-1 text-left text-xs text-dimmed hover:text-toned transition-colors"
                      @click="expandManager(g.key)"
                    >
                      Show {{ g.agents.length - g.shown.length }} more
                    </button>
                  </div>
                </div>

                <p class="border-t border-default px-3 py-2 text-xs text-dimmed leading-relaxed">
                  Only agents whose manager is a member of {{ projectName || 'this project' }}, or an admin.
                </p>
              </div>
            </template>
          </UPopover>
        </div>

        <template v-if="agentsOpen">
          <div
            v-for="(a, aIdx) in visibleAgents"
            :key="a.id"
            class="flex items-center gap-2 px-3 py-1.5"
            :class="[
              aIdx % 2 === 0 ? 'bg-muted' : 'bg-default',
              aIdx === visibleAgents.length - 1 && agentMembers.length <= visibleAgents.length && !isOwnerOrAdmin ? 'rounded-b-xl' : ''
            ]"
          >
            <UiAvatar
              :alt="a.name"
              kind="agent"
              :color="a.color"
              size="2xs"
            />
            <span class="text-sm font-medium flex-1 truncate">{{ a.name }}</span>
            <UBadge
              v-if="a.suspended"
              color="error"
              label="Suspended"
            />
            <UTooltip :text="a.managedBy ? `Managed by ${a.managedBy.name}` : 'No manager'">
              <UiAvatar
                v-if="a.managedBy"
                :src="a.managedBy.avatarUrl"
                :alt="a.managedBy.name"
                size="3xs"
              />
              <UIcon
                v-else
                name="i-lucide-user-x"
                class="text-sm text-warning"
              />
            </UTooltip>
            <UDropdownMenu
              v-if="canRemoveAgent(a)"
              :items="agentMenuItems(a)"
            >
              <button
                type="button"
                class="text-2xs font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full shrink-0 cursor-pointer transition hover:ring-2 hover:ring-primary/20 flex items-center gap-1 bg-elevated text-muted"
                :aria-label="`Role of ${a.name}: member. Agents are always members`"
              >
                <UIcon
                  name="i-lucide-lock"
                  class="text-2xs"
                />
                Member
                <UIcon
                  name="i-lucide-chevron-down"
                  class="text-2xs opacity-60"
                />
              </button>
            </UDropdownMenu>
            <span
              v-else
              class="text-2xs font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full shrink-0 flex items-center gap-1 bg-elevated text-muted"
            >
              <UIcon
                name="i-lucide-lock"
                class="text-2xs"
              />
              Member
            </span>
          </div>

          <button
            v-if="agentMembers.length > visibleAgents.length"
            type="button"
            class="w-full px-3 py-1.5 bg-default border-t border-default text-left text-xs font-medium text-dimmed hover:text-toned transition-colors"
            :class="!isOwnerOrAdmin ? 'rounded-b-xl' : ''"
            @click="showAllAgents = true"
          >
            Show {{ agentMembers.length - visibleAgents.length }} more
          </button>
          <p
            v-if="!agentMembers.length"
            class="bg-default px-3 pb-2 text-xs text-dimmed"
          >
            No agents in this project yet.
          </p>
        </template>
      </div>

      <!-- Pending invitations (owner/admin only) -->
      <template v-if="isOwnerOrAdmin && (invitations as ProjectInvitation[] | null)?.length">
        <div class="border-t border-muted bg-default px-3 py-2">
          <div
            v-for="inv in (invitations as ProjectInvitation[] | null)"
            :key="inv.id"
            class="flex items-center gap-2 py-1.5 group/inv"
          >
            <UIcon
              name="i-lucide-mail"
              class="text-base text-warning shrink-0"
            />
            <span class="text-sm font-mono text-muted flex-1 truncate">{{ inv.email }}</span>
            <UDropdownMenu :items="invitationMenuItems(inv)">
              <button
                type="button"
                class="text-2xs font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full shrink-0 cursor-pointer transition hover:ring-2 hover:ring-warning/20 flex items-center gap-1 bg-warning/10 text-warning"
                :disabled="resendingInvitation === inv.id || cancellingInvitation === inv.id"
              >
                <UIcon
                  v-if="resendingInvitation === inv.id || cancellingInvitation === inv.id"
                  name="i-lucide-loader-2"
                  class="text-2xs animate-spin"
                />
                <template v-else>
                  Pending
                  <UIcon
                    name="i-lucide-chevron-down"
                    class="text-2xs opacity-60"
                  />
                </template>
              </button>
            </UDropdownMenu>
          </div>
        </div>
      </template>

      <!-- Add member section (owner/admin only) -->
      <template v-if="isOwnerOrAdmin">
        <div class="relative border-t border-muted bg-default rounded-b-xl px-3 py-2">
          <div class="flex items-center gap-1.5 mb-2">
            <UIcon
              name="i-lucide-user-plus"
              class="text-sm text-dimmed"
            />
            <span class="text-2xs font-bold text-dimmed uppercase tracking-label">Add Member</span>
          </div>
          <input
            v-model="searchQuery"
            type="text"
            aria-label="Search people, or enter an email to invite"
            placeholder="Search by name or enter email to invite..."
            class="w-full text-base text-highlighted placeholder:text-dimmed bg-muted border border-default rounded-lg px-3 py-2 transition-colors"
            @focus="searchQuery.trim().length >= 2 && (showResults = true)"
            @blur="onInputBlur"
            @keydown="onInputKeydown"
          >
          <UIcon
            v-if="searching"
            name="i-lucide-loader-2"
            class="absolute right-6 bottom-4.5 text-base text-dimmed animate-spin"
          />

          <!-- Search results dropdown -->
          <div
            v-if="showResults && searchQuery.trim().length >= 2"
            class="absolute z-50 left-3 right-3 mt-1 rounded-lg border border-accented bg-default shadow-float overflow-hidden"
          >
            <button
              v-for="(u, i) in searchResults"
              :key="u.id"
              type="button"
              class="flex items-center gap-2.5 w-full px-3 py-2 transition-colors text-left cursor-pointer"
              :class="i === highlightIndex
                ? 'bg-primary/10'
                : 'hover:bg-elevated'"
              :disabled="adding"
              @mousedown.prevent="addMember(u)"
              @mouseenter="highlightIndex = i"
            >
              <UiAvatar
                :src="u.avatarUrl ?? undefined"
                :alt="u.name"
                size="xs"
              />
              <div class="min-w-0 flex-1">
                <div class="text-base font-medium text-highlighted truncate">
                  {{ u.name }}
                </div>
              </div>
              <UIcon
                name="i-lucide-plus"
                class="text-base text-dimmed shrink-0"
              />
            </button>

            <!-- Invite by email option when no results and valid email -->
            <button
              v-if="!searching && searchResults.length === 0 && isValidEmail(searchQuery.trim())"
              type="button"
              class="flex items-center gap-2.5 w-full px-3 py-2.5 transition-colors text-left cursor-pointer hover:bg-primary/10"
              :disabled="adding"
              @mousedown.prevent="inviteByEmail"
            >
              <div class="flex items-center justify-center w-6 h-6 rounded-full bg-primary/15">
                <UIcon
                  name="i-lucide-send"
                  class="text-xs text-primary"
                />
              </div>
              <div class="min-w-0 flex-1">
                <div class="text-base font-medium text-primary">
                  Invite {{ searchQuery.trim() }}
                </div>
                <div class="text-xs text-dimmed">
                  Send an invitation email
                </div>
              </div>
              <UIcon
                name="i-lucide-mail-plus"
                class="text-base text-primary shrink-0"
              />
            </button>

            <div
              v-if="!searching && searchResults.length === 0 && !isValidEmail(searchQuery.trim())"
              class="px-3 py-3 text-center text-sm text-dimmed"
            >
              No users found — enter a full email to invite
            </div>
          </div>

          <!-- Error -->
          <UAlert
            v-if="addError"
            color="error"
            variant="subtle"
            icon="i-lucide-alert-circle"
            :description="addError"
            class="mt-2"
          />
        </div>
      </template>
    </div>

    <div
      v-if="!(sortedMembers)?.length"
      class="py-4 text-center text-base text-dimmed"
    >
      No members
    </div>

    <!-- One click, no typed name: a membership is re-added from the field directly
         above this list, so it is the cheapest destructive action on the page.
         The glyph names the action rather than warning about it, for the same
         reason. -->
    <UiConfirmDialog
      v-model:open="confirmingRemove"
      icon="i-lucide-user-minus"
      :title="`Remove ${pendingRemove?.name ?? 'member'}`"
      :description="removeDescription"
      action-label="Remove from project"
      :loading="removing === pendingRemove?.id"
      @confirm="confirmRemoveMember"
    >
      <!-- What leaves with them. A person's agents can only be in projects that
           person is in, so removing the person takes the agents too. -->
      <template
        v-if="removeConsequences.agents.length || removeConsequences.cards"
        #body
      >
        <div v-if="removeConsequences.agents.length">
          <p class="text-sm text-default">
            <span class="font-semibold">{{ plural(removeConsequences.agents.length, 'agent') }}</span>
            {{ pendingRemove?.name }} manages {{ removeConsequences.agents.length === 1 ? 'leaves' : 'leave' }} {{ projectName || 'this project' }} too.
          </p>
          <div class="mt-2 rounded-lg border border-default px-3 py-2">
            <div class="flex items-center gap-2">
              <span class="flex -space-x-1 shrink-0">
                <UiAvatar
                  v-for="a in removeConsequences.agents.slice(0, 5)"
                  :key="a.id"
                  :alt="a.name"
                  kind="agent"
                  :color="a.color"
                  size="2xs"
                  class="ring-2 ring-bg"
                />
              </span>
              <span class="text-xs text-muted truncate">{{ summarizeNames(removeConsequences.agents.map(a => a.name)) }}</span>
              <UButton
                v-if="removeConsequences.agents.length > 3"
                :label="showRemovedAgents ? 'Hide' : 'Show'"
                :trailing-icon="showRemovedAgents ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
                variant="ghost"
                color="neutral"
                size="xs"
                class="ml-auto shrink-0"
                @click="showRemovedAgents = !showRemovedAgents"
              />
            </div>
            <ul
              v-if="showRemovedAgents"
              class="mt-2 flex flex-col gap-1"
            >
              <li
                v-for="a in removeConsequences.agents"
                :key="a.id"
              >
                <UiPerson
                  :person="a"
                  :chip="false"
                />
              </li>
            </ul>
          </div>
        </div>
        <p
          v-if="removeConsequences.cards"
          class="mt-2 text-xs text-muted"
        >
          {{ plural(removeConsequences.cards, 'card') }} {{ pendingRemove && isAgent(pendingRemove) ? 'it holds' : 'their agents hold' }} here {{ removeConsequences.cards === 1 ? 'becomes' : 'become' }} unassigned.
        </p>
      </template>
    </UiConfirmDialog>
  </div>
</template>
