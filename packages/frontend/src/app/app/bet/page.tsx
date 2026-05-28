import { redirect } from 'next/navigation'

export default function BetRedirectPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>
}) {
  const conditionId = typeof searchParams.conditionId === 'string' ? searchParams.conditionId : undefined
  if (conditionId) {
    const params = new URLSearchParams()
    Object.entries(searchParams).forEach(([key, value]) => {
      if (typeof value === 'string' && key !== 'conditionId') params.set(key, value)
    })
    params.set('modal', 'bet')
    redirect(`/app/market/${conditionId}?${params.toString()}`)
  }

  redirect('/app/markets')
}
