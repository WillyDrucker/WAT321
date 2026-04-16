import type {
  ProviderDescriptor,
  ProviderGroup,
  ProviderKey,
} from "./contracts";

/**
 * Provider lifecycle registry. Replaces the hand-maintained
 * `ActiveGroups` struct in bootstrap.ts and the per-provider
 * activate/deactivate functions. Adding a third provider means
 * one new `register()` call - no edits across 6 files.
 *
 * The registry owns activation state. It does NOT own services or
 * widgets - those are created by the provider-specific activation
 * function and handed to the registry as a `ProviderGroup`.
 */

type ActivateFn = () => ProviderGroup;

interface RegisteredProvider {
  descriptor: ProviderDescriptor;
  activate: ActivateFn;
  group: ProviderGroup | null;
}

export class ProviderRegistry {
  private providers = new Map<ProviderKey, RegisteredProvider>();

  /** Register a provider with its descriptor and activation
   * factory. Does not activate - call `activate(key)` separately. */
  register(descriptor: ProviderDescriptor, activate: ActivateFn): void {
    if (this.providers.has(descriptor.key)) {
      throw new Error(`[WAT321] Provider "${descriptor.key}" is already registered`);
    }
    this.providers.set(descriptor.key, {
      descriptor,
      activate,
      group: null,
    });
  }

  /** Activate a registered provider. No-op if already active or
   * not registered. Returns the group for callers that need it. */
  activate(key: ProviderKey): ProviderGroup | null {
    const entry = this.providers.get(key);
    if (!entry || entry.group) return entry?.group ?? null;
    entry.group = entry.activate();
    return entry.group;
  }

  /** Deactivate a provider: dispose all its resources and clear
   * the group. No-op if not active. */
  deactivate(key: ProviderKey): void {
    const entry = this.providers.get(key);
    if (!entry?.group) return;
    for (const d of entry.group.disposables) d.dispose();
    entry.group = null;
  }

  /** Is this provider currently active? */
  isActive(key: ProviderKey): boolean {
    return (this.providers.get(key)?.group ?? null) !== null;
  }

  /** Get the live group for a provider, or null. */
  getGroup(key: ProviderKey): ProviderGroup | null {
    return this.providers.get(key)?.group ?? null;
  }

  /** Count of providers with live ProviderGroup instances. This
   * is group activation count, not provider availability count -
   * display mode reads from `isProviderActive()` in displayMode.ts
   * which tracks actual service connectivity. */
  activeCount(): number {
    let count = 0;
    for (const entry of this.providers.values()) {
      if (entry.group) count++;
    }
    return count;
  }

  /** Rebroadcast state on all active services (usage + token). */
  rebroadcastAll(): void {
    for (const entry of this.providers.values()) {
      if (!entry.group) continue;
      entry.group.usageService.rebroadcast();
      entry.group.tokenService.rebroadcast();
    }
  }

  /** Reset kickstart escalation on all active usage services. */
  resetAllKickstartEscalation(): void {
    for (const entry of this.providers.values()) {
      entry.group?.usageService.resetKickstartEscalation();
    }
  }

  /** Dispose all active providers. Called from extension
   * `deactivate()`. */
  disposeAll(): void {
    for (const key of this.providers.keys()) {
      this.deactivate(key);
    }
  }

  /** Get the descriptor for a provider. */
  getDescriptor(key: ProviderKey): ProviderDescriptor | undefined {
    return this.providers.get(key)?.descriptor;
  }

  /** Iterate all registered provider keys. */
  keys(): IterableIterator<ProviderKey> {
    return this.providers.keys();
  }
}
