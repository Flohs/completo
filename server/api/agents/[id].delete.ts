import { eq } from 'drizzle-orm'

/**
 * Delete an agent. Its tokens and memberships go with it; its cards become
 * unassigned and its comments stay, as for a deleted person.
 */
export default defineEventHandler(async (event) => {
  const { agent } = await resolveManagedAgent(event)
  db.delete(schema.users).where(eq(schema.users.id, agent.id)).run()
  return { ok: true }
})
