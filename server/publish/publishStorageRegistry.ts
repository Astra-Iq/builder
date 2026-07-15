/**
 * Host-side publish storage adapter registry.
 *
 * The sibling of `src/core/plugins/mediaStorageRegistry.ts`, for baked static
 * output rather than media uploads. A full publish bakes each site's HTML/CSS/JS
 * into its local-disk slot (`staticArtefact.ts`); this registry decides where
 * that baked generation is additionally *pushed* — a CDN-backed object store
 * (S3/R2/GCS) for a real per-merchant deployment.
 *
 * The built-in local-disk adapter is registered at boot under the reserved `''`
 * id and is a no-op push (the bytes already live on local disk). Plugins with
 * the appropriate permission register remote adapters; a disabled/crashed
 * plugin's adapters are torn down via `unregisterPlugin`, same as media.
 *
 * Election surface: until an admin "active publish backend" picker exists
 * (a follow-up, mirroring media's persisted `active_media_storage_adapter`),
 * `resolveActive` returns the first-registered remote adapter, falling back to
 * the built-in local-disk no-op when none is registered.
 */

import type { PublishStorageAdapter } from '@core/plugin-sdk'

/**
 * Reserved id for the built-in local-disk adapter. Matches the media registry's
 * `''` sentinel: an empty id means "no remote elected → push is a local no-op".
 */
export const LOCAL_PUBLISH_ADAPTER_ID = '' as const

/**
 * The built-in adapter. Baked artefacts are already on local disk after the
 * slot swap, so every method is a no-op — there is nothing to ship or prune.
 */
function buildLocalDiskAdapter(): PublishStorageAdapter {
  return {
    id: LOCAL_PUBLISH_ADAPTER_ID,
    label: 'Local disk',
    putObject: async () => {},
    deleteObject: async () => {},
  }
}

class PublishStorageRegistry {
  private adapters = new Map<string, PublishStorageAdapter>()

  /**
   * Wire the built-in local-disk adapter. Called once per process boot from
   * `server/index.ts`. Idempotent.
   */
  configureLocalDisk(): void {
    this.adapters.set(LOCAL_PUBLISH_ADAPTER_ID, buildLocalDiskAdapter())
  }

  /**
   * Register a remote adapter. Re-registering the same id replaces the previous
   * definition (e.g. on plugin re-activation).
   */
  register(adapter: PublishStorageAdapter): void {
    if (!adapter.id) {
      throw new Error('[publishStorageRegistry] Adapter id is required')
    }
    if (adapter.id === LOCAL_PUBLISH_ADAPTER_ID) {
      throw new Error(
        `[publishStorageRegistry] Adapter id "" is reserved for the built-in local-disk adapter`,
      )
    }
    this.adapters.set(adapter.id, adapter)
  }

  /**
   * Tear down every adapter registered under a given plugin id. Called on
   * plugin disable / uninstall / crash recovery. The local-disk adapter is
   * never affected.
   */
  unregisterPlugin(pluginId: string): void {
    const prefix = `${pluginId}.`
    for (const id of this.adapters.keys()) {
      if (id === LOCAL_PUBLISH_ADAPTER_ID) continue
      if (id === pluginId || id.startsWith(prefix)) {
        this.adapters.delete(id)
      }
    }
  }

  /**
   * The adapter the publish pipeline pushes to. The first-registered remote
   * adapter wins; with none registered, the built-in local-disk no-op is
   * active. (Per-adapter admin election is a follow-up — see the module doc.)
   *
   * Unlike the media registry, this never throws on an un-configured registry:
   * "no remote elected" is the safe default, so it returns a local-disk no-op.
   * A publish push must never fail a publish just because boot wiring ran late
   * (e.g. a unit test that drives `publishDraftSite` without booting the host).
   */
  resolveActive(): PublishStorageAdapter {
    for (const [id, adapter] of this.adapters) {
      if (id !== LOCAL_PUBLISH_ADAPTER_ID) return adapter
    }
    return this.adapters.get(LOCAL_PUBLISH_ADAPTER_ID) ?? buildLocalDiskAdapter()
  }

  /** Snapshot every registered adapter — admin UI surface. */
  list(): PublishStorageAdapter[] {
    return Array.from(this.adapters.values())
  }

  /** Test-only reset. */
  __reset(): void {
    this.adapters.clear()
  }
}

export const publishStorageRegistry = new PublishStorageRegistry()
