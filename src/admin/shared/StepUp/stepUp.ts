/**
 * Step-up auth pass-through (hook + constant).
 *
 * Sensitive actions used to require a fresh password re-entry ("step-up")
 * gated by `runStepUp`. With Logto owning authentication there is no local
 * password to re-enter, so step-up is removed: `runStepUp` now simply runs the
 * action. The shape is preserved so the many call sites that thread `runStepUp`
 * through keep working without a mechanical unwrap. `StepUpCancelledMessage` is
 * retained as a constant so existing cancellation-detecting `catch` blocks
 * still compile — it is never thrown now.
 */
export const StepUpCancelledMessage = 'step_up_cancelled'

export interface StepUpApi {
  runStepUp: <T>(action: () => Promise<T> | T) => Promise<T>
}

export function useStepUp(): StepUpApi {
  return {
    runStepUp: (action) => Promise.resolve(action()),
  }
}
