import { describe, expect, it } from 'vitest'
import { appendCorrection, correctionEntries } from './corrections'
import { balances, creditEntry, transferEntry } from './ledger'
import { allowanceDue, allowanceEntry, type AllowanceConfig } from './allowance'
import { interestDue, interestEntry, matchDue, matchEntry, type InterestConfig } from './interest'
import type { Account } from './types'
const account: Account = { id:'a',child:'test',name:'Pot',currency:'GBP',custody:'ledger' }
const meta = { id:'original',child:'test',createdAt:100,author:'guardian' as const }
const correction = { ...meta,id:'fix',createdAt:200 }
describe('append-only corrections', () => {
  it('preserves the original, links reversal and replacement, and retries safely', () => {
    const original = creditEntry(meta,account,500,'gift')
    const bundle = correctionEntries(original,correction,'Wrong amount',[350])
    const next = appendCorrection([original],[account],bundle)
    expect(next[0]).toBe(original)
    expect(bundle[0]?.reverses).toBe(original.id)
    expect(bundle[1]?.correctionOf).toBe(original.id)
    expect(balances(next).get('a')).toBe(350)
    expect(appendCorrection(next,[account],bundle)).toBe(next)
    expect(() => appendCorrection(next,[account],correctionEntries(original,{...correction,id:'second'},'Another correction'))).toThrow()
  })
  it('refuses malformed or incomplete groups without mutating any money', () => {
    const original = creditEntry(meta,account,500)
    const entries = [original], bundle = correctionEntries(original,correction,'Wrong amount',[350])
    expect(() => appendCorrection(entries,[account],[bundle[0]!,{...bundle[1]!,child:'sibling'}])).toThrow()
    expect(() => appendCorrection(entries,[account],[{...bundle[0]!,legs:[{...bundle[0]!.legs[0]!,amountMinor:-501}]}])).toThrow()
    expect(entries).toEqual([original])
    expect(() => correctionEntries(original,correction,' ')).toThrow()
    expect(() => correctionEntries(original,correction,'reason',[1.5])).toThrow()
    expect(() => correctionEntries(bundle[0]!,correction,'reason')).toThrow()
  })
  it('corrects both transfer legs atomically and rejects an unbalanced replacement', () => {
    const other = {...account,id:'b'}, original = transferEntry(meta,account,other,500)
    const bundle = correctionEntries(original,correction,'Wrong amount',[200,200])
    expect(balances(appendCorrection([original],[account,other],bundle))).toEqual(new Map([['a',-200],['b',200]]))
    expect(() => correctionEntries(original,correction,'reason',[200,201])).toThrow()
  })
  it('refuses a resulting balance outside safe integer money', () => {
    const original = creditEntry(meta,account,1)
    const huge = creditEntry({...meta,id:'huge'},account,Number.MAX_SAFE_INTEGER - 1)
    expect(() => appendCorrection([original,huge],[account],correctionEntries(original,correction,'reason',[3]))).toThrow(/overflows/)
  })
  it('keeps corrected pocket-money, interest and match periods closed', () => {
    const now = Date.UTC(2026,7,21,8)/1000
    const cfg: AllowanceConfig = {child:'test',account:'a',amountMinor:500,cadence:'weekly',day:5,tz:'Europe/London',startDay:'2026-08-01'}
    const paid = allowanceEntry(cfg,account,'2026-08-07',meta)
    expect(allowanceDue(cfg,[paid,...correctionEntries(paid,correction,'Not due')],now)).not.toContain('2026-08-07')
    const interest: InterestConfig = {...cfg,rateBps:100,matchBps:5000}
    const payout = interestEntry(interest,account,'2026-08-07',1000,meta)
    if (!payout) throw new Error('Expected interest fixture')
    expect(interestDue(interest,[payout,...correctionEntries(payout,correction,'Wrong rate')],now)).not.toContain('2026-08-07')
    const match = matchEntry(interest,account,'2026-08-07',1000,meta)
    if (!match) throw new Error('Expected match fixture')
    expect(matchDue(interest,[match,...correctionEntries(match,correction,'Wrong match')],now)).not.toContain('2026-08-07')
  })
})
