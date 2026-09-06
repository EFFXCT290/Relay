import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { usePushSubscription } from "./use-push-subscription";

let vapidKey: string;
vi.mock("@/frontend-core/runtime-env", () => ({
  getVapidPublicKey: () => vapidKey,
}));

const { pushApiMock } = vi.hoisted(() => ({
  pushApiMock: {
    subscribe: vi.fn(async () => {}),
    unsubscribe: vi.fn(async () => {}),
  },
}));
vi.mock("@/frontend-core/api-client/push", () => ({
  pushApi: pushApiMock,
}));

class FakeSubscription {
  endpoint = "https://push.example/ep-1";
  unsubscribeCalled = false;
  toJSON() {
    return { endpoint: this.endpoint, keys: { p256dh: "p", auth: "a" } };
  }
  async unsubscribe() {
    this.unsubscribeCalled = true;
    return true;
  }
}

class FakeNotification {
  static permission: NotificationPermission = "default";
  static requestPermission = vi.fn(async () => FakeNotification.permission);
}

function makeRegistration(initialSub: FakeSubscription | null) {
  let sub: FakeSubscription | null = initialSub;
  const subscribeSpy = vi.fn(async () => {
    sub = new FakeSubscription();
    return sub;
  });
  const getSubscriptionSpy = vi.fn(async () => sub);
  return { pushManager: { getSubscription: getSubscriptionSpy, subscribe: subscribeSpy } };
}

function installBrowserSupport(registration: ReturnType<typeof makeRegistration>) {
  vi.stubGlobal("PushManager", class {});
  vi.stubGlobal("Notification", FakeNotification);
  Object.defineProperty(globalThis.navigator, "serviceWorker", {
    value: { ready: Promise.resolve(registration) },
    configurable: true,
  });
  // usePushSubscription only reads window.matchMedia via detectStandalone —
  // jsdom doesn't implement it at all, so a minimal stub avoids a crash.
  Object.defineProperty(window, "matchMedia", {
    value: (query: string) => ({ matches: false, media: query }),
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  vapidKey = "a-real-vapid-key";
  FakeNotification.permission = "default";
  pushApiMock.subscribe.mockClear();
  pushApiMock.unsubscribe.mockClear();
});

describe("usePushSubscription — permission branches", () => {
  it("permission granted, no existing subscription: creates one via pushManager.subscribe and registers it with the server", async () => {
    FakeNotification.permission = "granted";
    const registration = makeRegistration(null);
    installBrowserSupport(registration);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.supported).toBe(true));

    await act(async () => {
      await result.current.subscribe();
    });

    expect(registration.pushManager.subscribe).toHaveBeenCalledTimes(1);
    expect(pushApiMock.subscribe).toHaveBeenCalledTimes(1);
    expect(pushApiMock.subscribe).toHaveBeenCalledWith({ endpoint: "https://push.example/ep-1", keys: { p256dh: "p", auth: "a" } });
    expect(result.current.isSubscribed).toBe(true);
    expect(result.current.error).toBeNull();
  });

  it("permission denied: surfaces a clear error, never touches pushManager.subscribe or the server", async () => {
    FakeNotification.permission = "denied";
    const registration = makeRegistration(null);
    installBrowserSupport(registration);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.supported).toBe(true));

    await act(async () => {
      await result.current.subscribe();
    });

    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(pushApiMock.subscribe).not.toHaveBeenCalled();
    expect(result.current.isSubscribed).toBe(false);
    expect(result.current.error).toMatch(/blocked/i);
  });

  it("permission dismissed (\"default\", neither granted nor denied): no error banner, no subscription attempt", async () => {
    FakeNotification.permission = "default"; // requestPermission() also resolves "default" per our fake's static field
    const registration = makeRegistration(null);
    installBrowserSupport(registration);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.supported).toBe(true));

    await act(async () => {
      await result.current.subscribe();
    });

    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(pushApiMock.subscribe).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull(); // only "denied" gets an explicit message
  });

  it("no VAPID key configured on the server: granted permission still fails cleanly, before ever calling pushManager.subscribe", async () => {
    FakeNotification.permission = "granted";
    vapidKey = ""; // getVapidPublicKey()'s documented "push isn't configured" sentinel
    const registration = makeRegistration(null);
    installBrowserSupport(registration);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.supported).toBe(true));

    await act(async () => {
      await result.current.subscribe();
    });

    expect(registration.pushManager.subscribe).not.toHaveBeenCalled();
    expect(pushApiMock.subscribe).not.toHaveBeenCalled();
    expect(result.current.isSubscribed).toBe(false);
    expect(result.current.error).toMatch(/not configured|isn't configured/i);
  });
});

describe("usePushSubscription — existing-subscription reuse", () => {
  it("reuses an already-active subscription instead of creating a new one", async () => {
    FakeNotification.permission = "granted";
    const existing = new FakeSubscription();
    const registration = makeRegistration(existing);
    installBrowserSupport(registration);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.supported).toBe(true));
    // The mount effect itself detects the pre-existing subscription.
    await waitFor(() => expect(result.current.isSubscribed).toBe(true));

    await act(async () => {
      await result.current.subscribe();
    });

    expect(registration.pushManager.subscribe).not.toHaveBeenCalled(); // no NEW subscription created
    expect(pushApiMock.subscribe).toHaveBeenCalledTimes(1); // still re-registers the existing one with the server
    expect(pushApiMock.subscribe).toHaveBeenCalledWith(existing.toJSON());
    expect(result.current.isSubscribed).toBe(true);
  });

  it("unsubscribe() releases the existing subscription and notifies the server", async () => {
    const existing = new FakeSubscription();
    const registration = makeRegistration(existing);
    installBrowserSupport(registration);

    const { result } = renderHook(() => usePushSubscription());
    await waitFor(() => expect(result.current.isSubscribed).toBe(true));

    await act(async () => {
      await result.current.unsubscribe();
    });

    expect(pushApiMock.unsubscribe).toHaveBeenCalledWith(existing.endpoint);
    expect(existing.unsubscribeCalled).toBe(true);
    expect(result.current.isSubscribed).toBe(false);
  });
});
