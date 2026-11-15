import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Check, Loader2, Lock, X } from 'lucide-react'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import {
  publicFetch, startCheckout, formatPrice,
  type BillingInterval, type BillingPrice, type PublicStatus,
} from '@/lib/public-api'

// Upgrade to Subscriber on the public elpgpt.com/chat. Payment happens on
// Stripe's hosted Checkout page; the plan changes when Stripe's webhook
// reaches the server, which the chat then picks up (hooks/use-billing-return).

interface UpgradeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: PublicStatus | undefined
  /** Guests need an account first: close this and open the account dialog. */
  onNeedAccount: () => void
}

export function UpgradeDialog({ open, onOpenChange, status, onNeedAccount }: UpgradeDialogProps) {
  const { t, locale } = useI18n()
  const { data, isLoading } = useQuery<{ prices: BillingPrice[] }>({
    queryKey: ['public-billing-prices'],
    queryFn: () => publicFetch('/api/public/billing/prices'),
    enabled: open && !!status?.billing?.enabled,
    staleTime: 10 * 60_000,
  })
  const prices = data?.prices ?? []
  const [interval, setChosenInterval] = useState<BillingInterval>('month')
  const [busy, setBusy] = useState(false)
  const chosen = prices.find(p => p.interval === interval) ?? prices[0]
  const isMember = !!status?.member

  const checkout = async () => {
    if (!chosen) return
    setBusy(true)
    try {
      window.location.assign(await startCheckout(chosen.interval))
    } catch (err) {
      toast.error(t('chat.public.billing.failed', { error: err instanceof Error ? err.message : String(err) }))
      setBusy(false)
    }
  }

  const perks = [
    t('chat.public.billing.perkModels'),
    t('chat.public.billing.perkMessages', { limit: status?.limits?.subscriber ?? 0 }),
    t('chat.public.billing.perkVoice'),
    t('chat.public.billing.perkFairUse'),
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-md" className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <DialogTitle className="text-base font-semibold">{t('chat.public.billing.title')}</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">{t('chat.public.billing.description')}</DialogDescription>
          </div>
          <DialogClose aria-label={t('common.dismiss')} className="rounded-lg p-1 text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </DialogClose>
        </div>

        <ul className="flex flex-col gap-1.5 text-sm">
          {perks.map(perk => (
            <li key={perk} className="flex items-start gap-2"><Check className="mt-0.5 size-4 shrink-0 text-primary" /> {perk}</li>
          ))}
        </ul>

        {isLoading ? (
          <div className="flex justify-center py-3 text-muted-foreground"><Loader2 className="size-4 animate-spin" /></div>
        ) : prices.length > 0 && (
          <div role="radiogroup" aria-label={t('chat.public.billing.period')} className="grid gap-2 sm:grid-cols-2">
            {prices.map(price => {
              const amount = formatPrice(price, locale)
              const selected = chosen?.interval === price.interval
              return (
                <button key={price.interval} type="button" role="radio" aria-checked={selected}
                  onClick={() => setChosenInterval(price.interval)}
                  className={cn('flex flex-col items-start gap-0.5 rounded-xl border px-3 py-2 text-start transition-colors',
                    selected ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted')}>
                  <span className="text-sm font-medium">{price.interval === 'month' ? t('chat.public.billing.monthly') : t('chat.public.billing.yearly')}</span>
                  {amount && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {price.interval === 'month' ? t('chat.public.billing.perMonth', { price: amount }) : t('chat.public.billing.perYear', { price: amount })}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {isMember ? (
          <Button onClick={() => void checkout()} disabled={busy || !chosen}>
            {busy ? <Loader2 className="animate-spin" /> : <Lock />} {t('chat.public.billing.continue')}
          </Button>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">{t('chat.public.billing.signInFirst')}</p>
            <Button onClick={onNeedAccount}>{t('chat.public.createAccount')}</Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t('chat.public.billing.secureNote')}</p>
      </DialogPopup>
    </Dialog>
  )
}
