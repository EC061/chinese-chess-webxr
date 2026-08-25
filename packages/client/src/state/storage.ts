/**
 * Asking the browser to keep this site's data.
 *
 * A headset is not a phone you pick up forty times a day. It sits in a drawer
 * for three weeks, and when storage runs short a browser evicts the sites it
 * judges least important — which is exactly what a rarely-opened site looks
 * like. Persistent storage exempts the origin from that sweep, cookies
 * included, so the session survives the gap between sessions.
 *
 * Chromium may grant this silently on an engagement signal rather than
 * prompting, so a refusal is not an error worth showing anyone: the session
 * still works, it is just evictable.
 */
export const requestPersistentStorage = async (): Promise<boolean> => {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
};

export const storageIsPersisted = async (): Promise<boolean> => {
  try {
    return (await navigator.storage?.persisted?.()) ?? false;
  } catch {
    return false;
  }
};
