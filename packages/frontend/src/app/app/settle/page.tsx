import { redirect } from 'next/navigation'

export default function SettleRedirectPage() {
  redirect('/app/portfolio?modal=settle')
}
