// Typed event bus — used for frontend socket events, backend emit consistency,
// and worker triggers. Decouples emitters from consumers without a full message queue.

type Handler<T> = (payload: T) => void | Promise<void>;

class EventBus {
  private handlers = new Map<string, Set<Handler<unknown>>>();

  on<T>(event: string, handler: Handler<T>) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler as Handler<unknown>);
    return () => this.off(event, handler);
  }

  off<T>(event: string, handler: Handler<T>) {
    this.handlers.get(event)?.delete(handler as Handler<unknown>);
  }

  async emit<T>(event: string, payload: T) {
    const fns = this.handlers.get(event);
    if (!fns) return;
    await Promise.all([...fns].map((fn) => fn(payload as unknown)));
  }
}

export const eventBus = new EventBus();
