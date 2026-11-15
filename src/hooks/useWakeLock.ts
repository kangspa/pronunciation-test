import { useEffect } from 'react';

// Keeps the screen on while `active`: long analyses on a phone otherwise stop
// when the screen locks. Silently does nothing where the API is missing.
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let released = false;
    navigator.wakeLock
      .request('screen')
      .then((l) => {
        if (released) void l.release();
        else lock = l;
      })
      .catch(() => {});
    return () => {
      released = true;
      void lock?.release().catch(() => {});
    };
  }, [active]);
}
