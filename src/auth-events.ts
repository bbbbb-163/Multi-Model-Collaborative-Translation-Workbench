export type AuthScope = "admin" | "user";
const channel =
  typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel("mstar-auth");
export function notifyAuthChange(scope: AuthScope) {
  channel?.postMessage({ scope });
}
export function subscribeAuthChange(scope: AuthScope, listener: () => void) {
  const receive = (event: MessageEvent) => {
    if (event.data?.scope === scope) listener();
  };
  channel?.addEventListener("message", receive);
  return () => channel?.removeEventListener("message", receive);
}
