import { redirect } from 'next/navigation'

export default async function BetRedirectPage({
  searchParams,
}: {
  // Next 15: searchParams is async (a Promise)
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const conditionId = typeof sp.conditionId === 'string' ? sp.conditionId : undefined
  if (conditionId) {
    const params = new URLSearchParams()
    Object.entries(sp).forEach(([key, value]) => {
      if (typeof value === 'string' && key !== 'conditionId') params.set(key, value)
    })
    params.set('modal', 'bet')
    redirect(`/app/market/${conditionId}?${params.toString()}`)
  }

  redirect('/app/markets')
}
