/**
 * HelpLink — the one link into Help that pages outside Help use (the intake
 * problem list's code links today). It builds the path through `helpPath`
 * and, when a step view is on screen, carries that step's URL as router
 * state (`helpLinkState`), so Help shows "Back to step N" to it. From any
 * other page the link carries no state and Help shows no such button.
 *
 * The step on screen is read from the step trail's store
 * (`txrintake/lib/stepTrail.ts`, imported directly for the same reason
 * `HelpPage` imports the intake internals: the intake module already
 * depends on this one).
 */
import type { ReactNode } from 'react'
import { Link, type LinkProps } from 'react-router-dom'
import { useStore } from 'zustand'
import { useStepTrailStore } from '@/modules/txrintake/lib/stepTrail'
import { helpLinkState, helpPath } from '../routes'

export interface HelpLinkProps extends Omit<LinkProps, 'to' | 'state'> {
  /** The Help entry to open (`problemAnchorOf(code)`, a section id), or the page top. */
  anchor?: string
  children?: ReactNode
}

export function HelpLink({ anchor, children, ...rest }: HelpLinkProps) {
  const stepUrl = useStore(useStepTrailStore, s => s.current?.url ?? null)
  return (
    <Link
      {...rest}
      to={helpPath(anchor)}
      state={stepUrl === null ? undefined : helpLinkState(stepUrl)}
    >
      {children}
    </Link>
  )
}
