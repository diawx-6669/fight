/**
 * A typed publish/subscribe bus.
 *
 * Subsystems stay decoupled: the vision pipeline emits `action:punch` without
 * knowing the fighter exists, and the HUD listens for `combat:hit` without
 * knowing who threw it.
 *
 * Handlers added during a dispatch are not invoked until the next one, and
 * removing a handler mid-dispatch takes effect immediately — both of which
 * matter because game logic routinely unsubscribes itself from its own handler.
 */
export type Handler<T> = (payload: T) => void;

/**
 * Any object type works as an event map. It is deliberately not
 * `Record<string, unknown>`: an `interface` has no implicit index signature, so
 * that constraint would reject exactly the declarations this bus exists for.
 */
export type EventMap = object;

interface Subscription<T> {
  handler: Handler<T>;
  once: boolean;
  removed: boolean;
}

export class EventBus<Events extends EventMap> {
  private readonly channels = new Map<keyof Events, Subscription<never>[]>();
  private dispatchDepth = 0;
  private needsCompaction = false;

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    return this.subscribe(event, handler, false);
  }

  once<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    return this.subscribe(event, handler, true);
  }

  private subscribe<K extends keyof Events>(
    event: K,
    handler: Handler<Events[K]>,
    once: boolean,
  ): () => void {
    let list = this.channels.get(event);
    if (!list) {
      list = [];
      this.channels.set(event, list);
    }
    const subscription: Subscription<Events[K]> = { handler, once, removed: false };
    (list as Subscription<Events[K]>[]).push(subscription);
    return () => {
      if (subscription.removed) return;
      subscription.removed = true;
      this.needsCompaction = true;
      if (this.dispatchDepth === 0) this.compact();
    };
  }

  off<K extends keyof Events>(event: K, handler: Handler<Events[K]>): void {
    const list = this.channels.get(event) as Subscription<Events[K]>[] | undefined;
    if (!list) return;
    for (const subscription of list) {
      if (subscription.handler === handler) {
        subscription.removed = true;
        this.needsCompaction = true;
      }
    }
    if (this.dispatchDepth === 0) this.compact();
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const list = this.channels.get(event) as Subscription<Events[K]>[] | undefined;
    if (!list || list.length === 0) return;

    this.dispatchDepth++;
    // Snapshot the length so handlers registered during dispatch wait a turn.
    const length = list.length;
    try {
      for (let i = 0; i < length; i++) {
        const subscription = list[i];
        if (subscription.removed) continue;
        if (subscription.once) {
          subscription.removed = true;
          this.needsCompaction = true;
        }
        subscription.handler(payload);
      }
    } finally {
      this.dispatchDepth--;
      if (this.dispatchDepth === 0 && this.needsCompaction) this.compact();
    }
  }

  /** Number of live handlers on a channel — used by tests and the debug HUD. */
  listenerCount<K extends keyof Events>(event: K): number {
    const list = this.channels.get(event);
    if (!list) return 0;
    let count = 0;
    for (const subscription of list) if (!subscription.removed) count++;
    return count;
  }

  clear<K extends keyof Events>(event?: K): void {
    if (event === undefined) {
      this.channels.clear();
      return;
    }
    this.channels.delete(event);
  }

  private compact(): void {
    this.needsCompaction = false;
    for (const [event, list] of this.channels) {
      const live = list.filter((subscription) => !subscription.removed);
      if (live.length === 0) this.channels.delete(event);
      else this.channels.set(event, live);
    }
  }
}
