import type { ReactNode } from 'react'

/**
 * Inert step-up provider. Step-up re-authentication was removed with the Logto
 * migration; this wrapper is kept as a pass-through so the mount points that
 * previously wrapped the tree don't need to change.
 */
export function StepUpProvider({ children }: { children: ReactNode }) {
  return <>{children}</>
}
