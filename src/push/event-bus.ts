import type { AlgorithmEvent, Signature, FrontendCacheEntry } from '../types/index.js';

type EventHandler = (event: AlgorithmEvent) => void;

/**
 * EventBus with reference-counted frontend graph cache layer.
 *
 * When clients subscribe to a signature, the reference count goes up.
 * When they unsubscribe, it goes down.
 *
 * On cache expiry: if clientCount > 0, the result is pushed to frontend
 * in-memory and served by signature (graph caching layer). If clientCount
 * is 0, the entry is simply evicted.
 */
export class EventBus {
  private handlers = new Set<EventHandler>();
  /** Per-signature subscriber count */
  private signatureSubscribers = new Map<Signature, number>();
  /** Frontend in-memory graph cache: signature-keyed */
  private frontendCache = new Map<Signature, FrontendCacheEntry>();

  /** Subscribe to all events + optionally track interest in a signature */
  subscribe(handler: EventHandler, signature?: Signature): () => void {
    this.handlers.add(handler);

    if (signature) {
      const count = this.signatureSubscribers.get(signature) || 0;
      this.signatureSubscribers.set(signature, count + 1);
    }

    return () => {
      this.handlers.delete(handler);
      if (signature) {
        const count = this.signatureSubscribers.get(signature) || 0;
        if (count <= 1) {
          this.signatureSubscribers.delete(signature);
        } else {
          this.signatureSubscribers.set(signature, count - 1);
        }
      }
    };
  }

  /** Check if there are active clients for a signature */
  hasClients(signature: Signature): boolean {
    return (this.signatureSubscribers.get(signature) || 0) > 0;
  }

  emit(event: AlgorithmEvent): void {
    switch (event.type) {
      case 'job_complete':
        // Store result in frontend cache
        this.frontendCache.set(event.signature, {
          signature: event.signature,
          result: event.result,
          expiresAt: Date.now() + 60_000, // will be updated by caller
          refreshRateMs: 5_000,
          clientCount: this.signatureSubscribers.get(event.signature) || 0,
          lastPushedAt: Date.now(),
        });
        break;

      case 'cache_expire':
        // If there are clients, push to frontend in-memory; otherwise evict
        if (this.hasClients(event.signature)) {
          this.pushToFrontendCache(event.signature);
        } else {
          this.frontendCache.delete(event.signature);
        }
        break;
    }

    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // Subscriber errors don't kill the bus
      }
    }
  }

  markStale(signature: Signature): void {
    const entry = this.frontendCache.get(signature);
    if (entry) {
      // Mark stale but keep serving until new result arrives
      entry.expiresAt = 0;
    }
  }

  /** Get cached result from frontend in-memory cache */
  getCachedResult(signature: Signature): Buffer | null {
    const entry = this.frontendCache.get(signature);
    if (!entry) return null;
    return entry.result;
  }

  /** Get full frontend cache entry */
  getCacheEntry(signature: Signature): FrontendCacheEntry | null {
    return this.frontendCache.get(signature) || null;
  }

  /** Push cache to frontend in-memory on expiry with active clients */
  private pushToFrontendCache(signature: Signature): void {
    const entry = this.frontendCache.get(signature);
    if (!entry) return;

    // Emit cache_push so frontend layer can pick it up
    const pushEvent: AlgorithmEvent = {
      type: 'cache_push',
      signature,
      result: entry.result,
      expiresAt: entry.expiresAt,
    };

    for (const handler of this.handlers) {
      try {
        handler(pushEvent);
      } catch {
        // continue
      }
    }
  }

  clearCache(): void {
    this.frontendCache.clear();
  }
}