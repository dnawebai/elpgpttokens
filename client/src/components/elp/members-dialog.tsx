import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogDescription, DialogPopup, DialogTitle } from '@/components/ui/dialog'

// Operator view of public chat members. Billing is not wired yet, so this is
// where a member is moved to the subscriber plan (premium models, voice and
// the live interpreter) or disabled.

interface MemberRow {
  id: number
  email: string
  plan: 'free' | 'subscriber'
  disabled: boolean
  createdAt: string
  today: { limit: number; used: number; remaining: number }
}

interface MembersResponse {
  publicChatEnabled: boolean
  limits: { visitor: number; free: number; subscriber: number }
  members: MemberRow[]
}

export function MembersDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const { data } = useQuery<MembersResponse>({ queryKey: ['elp-members'], queryFn: () => apiFetch('/api/elp/members'), enabled: open })
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: Partial<Pick<MemberRow, 'plan' | 'disabled'>> }) =>
      apiFetch(`/api/elp/members/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['elp-members'] }),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-3xl" className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <DialogTitle className="text-base font-semibold">{t('chat.members.title')}</DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground">{t('chat.members.description')}</DialogDescription>
          </div>
          <DialogClose aria-label={t('common.dismiss')} className="rounded-lg p-1 text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </DialogClose>
        </div>

        {data && !data.publicChatEnabled && (
          <p className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
            {t('chat.members.disabledNotice')}
          </p>
        )}
        {data && <p className="text-xs text-muted-foreground">{t('chat.members.limits', data.limits)}</p>}

        {data && data.members.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('chat.members.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">{t('chat.members.email')}</th>
                  <th className="py-1 pr-3 font-medium">{t('chat.members.plan')}</th>
                  <th className="py-1 pr-3 font-medium">{t('chat.members.today')}</th>
                  <th className="py-1 font-medium">{t('chat.members.status')}</th>
                </tr>
              </thead>
              <tbody>
                {data?.members.map(m => (
                  <tr key={m.id} className="border-t">
                    <td className="max-w-56 truncate py-2 pr-3">{m.email}</td>
                    <td className="py-2 pr-3">
                      <select value={m.plan} aria-label={t('chat.members.plan')} disabled={update.isPending}
                        onChange={e => update.mutate({ id: m.id, patch: { plan: e.target.value as MemberRow['plan'] } })}
                        className="rounded-md border bg-background px-1.5 py-1">
                        <option value="free">{t('chat.public.free')}</option>
                        <option value="subscriber">{t('chat.public.subscriber')}</option>
                      </select>
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-muted-foreground">{m.today.used} / {m.today.limit}</td>
                    <td className="py-2">
                      <Button size="xs" variant={m.disabled ? 'secondary' : 'ghost'} disabled={update.isPending}
                        onClick={() => update.mutate({ id: m.id, patch: { disabled: !m.disabled } })}>
                        {m.disabled ? t('chat.members.enable') : t('chat.members.disable')}
                      </Button>
                      <span className="ms-2 text-xs text-muted-foreground">{m.disabled ? t('chat.members.disabled') : t('chat.members.active')}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DialogPopup>
    </Dialog>
  )
}
