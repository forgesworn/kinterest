export interface Chore {
  id: string
  child: string
  name: string
  cadence: 'daily' | 'weekly'
  archived?: boolean
}

export interface ChoreTick {
  id: string
  chore: string
  day: string // day key the tick applies to
  at: number // unix seconds
}

export function tickedDays(chore: Chore, ticks: ChoreTick[]): Set<string> {
  return new Set(ticks.filter((t) => t.chore === chore.id).map((t) => t.day))
}

export function periodComplete(chores: Chore[], ticks: ChoreTick[], periodDays: string[]): boolean {
  if (periodDays.length === 0) return false
  const active = chores.filter((c) => !c.archived)
  if (active.length === 0) return false
  const days = new Set(periodDays)
  return active.every((chore) => {
    const done = tickedDays(chore, ticks)
    if (chore.cadence === 'daily') return periodDays.every((d) => done.has(d))
    return [...done].some((d) => days.has(d))
  })
}
