import type { InboxItem } from './filesystem/library-watcher.js';

type InboxListener = (item: InboxItem) => void;

/**
 * In-process event hub for persisting watcher updates to SSE clients.
 */
export class InboxEventBus {
  private readonly listeners = new Set<InboxListener>();

  /**
   * Registers a listener for inbox changes.
   *
   * @param listener Callback invoked with the full updated inbox item.
   * @returns A function that removes the listener.
   */
  subscribe(listener: InboxListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Publishes an updated inbox item to connected subscribers.
   *
   * @param item Current persisted inbox state.
   */
  publish(item: InboxItem): void {
    for (const listener of this.listeners) {
      listener(item);
    }
  }
}
