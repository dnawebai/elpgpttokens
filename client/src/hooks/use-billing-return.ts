import { useEffect, useRef, useState } from 'react'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { readBillingReturn, type PublicStatus } from '@/lib/public-api'

const ACTIVATION_POLL_MS = 2000
const ACTIVATION_TIMEOUT_MS = 30_000

/**
 * Handle the return from Stripe Checkout (`/chat?billing=success|cancel`):
 * strip the flag from the address bar, then on success refresh the public
 * status until Stripe's webhook has made the member a Subscriber. The plan is
 * never taken from the URL; only the server's status counts.
 */
export function useBillingReturn(enabled: boolean, status: PublicStatus | undefined, refetch: () => Promise<unknown>) {
  const { t } = useI18n()
  const [outcome] = useState(() => (enabled ? readBillingReturn(window.location.search) : null))
  const [timedOut, setTimedOut] = useState(false)
  const announced = useRef(false)
  const activatedShown = useRef(false)
  const startedAt = useRef<number | null>(null)
  const subscribed = status?.tier === 'subscriber'
  const activating = outcome === 'success' && !subscribed && !timedOut

  useEffect(() => {
    if (!outcome || announced.current) return
    announced.current = true
    const url = new URL(window.location.href)
    url.searchParams.delete('billing')
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    if (outcome === 'cancel') toast.info(t('chat.public.billing.cancelled'))
    else toast.success(t('chat.public.billing.success'))
  }, [outcome, t])

  useEffect(() => {
    if (outcome !== 'success' || !subscribed || activatedShown.current) return
    activatedShown.current = true
    toast.success(t('chat.public.billing.activated'))
  }, [outcome, subscribed, t])

  useEffect(() => {
    if (!activating) return
    startedAt.current ??= Date.now()
    const timer = window.setInterval(() => {
      if (Date.now() - (startedAt.current ?? 0) > ACTIVATION_TIMEOUT_MS) {
        window.clearInterval(timer)
        setTimedOut(true)
        toast.info(t('chat.public.billing.pending'))
        return
      }
      void refetch()
    }, ACTIVATION_POLL_MS)
    return () => window.clearInterval(timer)
  }, [activating, refetch, t])

  return { activating }
}
