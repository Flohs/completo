export default defineEventHandler(async (event) => {
  const session = await requireUserSession(event)
  const { name, expiresInDays } = await readBody<{ name?: string, expiresInDays?: number }>(event)
  return mintApiToken(session.user.id, { name, expiresInDays })
})
