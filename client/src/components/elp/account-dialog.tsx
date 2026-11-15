import { useState, type FormEvent } from 'react'
import { X } from 'lucide-react'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { publicFetch, PublicApiError, type PublicStatus } from '@/lib/public-api'

// Sign in / create account for the public elpgpt.com/chat. A member account is
// not a dashboard account: it only raises the daily message limit (and, once
// the operator grants the subscriber plan, unlocks premium models).

interface AccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: PublicStatus | undefined
  onAuthed: (token: string) => void
}

export function AccountDialog({ open, onOpenChange, status, onAuthed }: AccountDialogProps) {
  const { t } = useI18n()
  const signupEnabled = status?.signupEnabled ?? false
  const [tab, setTab] = useState<'signin' | 'signup'>(signupEnabled ? 'signup' : 'signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await publicFetch<{ token: string }>(tab === 'signup' ? '/api/public/signup' : '/api/public/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
      setPassword('')
      onAuthed(res.token)
      onOpenChange(false)
    } catch (err) {
      setError(err instanceof PublicApiError || err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const limits = status?.limits
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-md" className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <DialogTitle className="text-base font-semibold">{t('chat.public.account.title')}</DialogTitle>
            {limits && (
              <DialogDescription className="text-sm text-muted-foreground">
                {t('chat.public.account.why', { free: limits.free, subscriber: limits.subscriber })}
              </DialogDescription>
            )}
          </div>
          <DialogClose aria-label={t('common.dismiss')} className="rounded-lg p-1 text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </DialogClose>
        </div>

        <div role="tablist" className="inline-flex w-fit rounded-md border p-0.5 text-sm">
          {(['signin', 'signup'] as const).map(value => (
            <button key={value} type="button" role="tab" aria-selected={tab === value}
              onClick={() => { setTab(value); setError(null) }}
              className={cn('rounded px-3 py-1', tab === value && 'bg-muted font-medium')}>
              {value === 'signin' ? t('chat.public.signIn') : t('chat.public.createAccount')}
            </button>
          ))}
        </div>

        {tab === 'signup' && !signupEnabled ? (
          <p className="text-sm text-muted-foreground">{t('chat.public.account.signupClosed')}</p>
        ) : (
          <form onSubmit={e => void submit(e)} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span>{t('chat.public.account.email')}</span>
              <input type="email" required autoComplete="email" value={email} onChange={e => setEmail(e.target.value)}
                className="rounded-md border bg-background px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span>{t('chat.public.account.password')}</span>
              <input type="password" required minLength={8} autoComplete={tab === 'signup' ? 'new-password' : 'current-password'}
                value={password} onChange={e => setPassword(e.target.value)} className="rounded-md border bg-background px-3 py-2" />
              {tab === 'signup' && <span className="text-xs text-muted-foreground">{t('chat.public.account.passwordHint')}</span>}
            </label>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy}>
              {tab === 'signup' ? t('chat.public.createAccount') : t('chat.public.signIn')}
            </Button>
          </form>
        )}
      </DialogPopup>
    </Dialog>
  )
}
