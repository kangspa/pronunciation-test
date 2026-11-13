import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_SECONDS, startRecording } from '../lib/recorder';
import type { ActiveRecording, Recording } from '../lib/recorder';

export function micErrorMessage(err: unknown): string {
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return '마이크 권한이 거부됐어요. 주소창의 사이트 설정에서 마이크를 허용해 주세요.';
  }
  return `마이크를 시작할 수 없어요: ${err instanceof Error ? err.message : String(err)}`;
}

// Owns one mic recording at a time and guarantees the stream is released on
// unmount, on repeat clicks, and when the page is left mid-permission-prompt.
// onLimit fires once maxSeconds is reached.
export function useRecorder(onLimit: () => void, maxSeconds = MAX_SECONDS) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const recRef = useRef<ActiveRecording | null>(null);
  const startingRef = useRef(false);
  const mountedRef = useRef(true);
  const meterRef = useRef<HTMLDivElement>(null);
  const onLimitRef = useRef(onLimit);

  useEffect(() => {
    onLimitRef.current = onLimit;
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      recRef.current?.cancel();
      recRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!recording) return;
    const startedAt = performance.now();
    let raf = 0;
    const tick = () => {
      const rec = recRef.current;
      if (!rec) return;
      const secs = (performance.now() - startedAt) / 1000;
      setElapsed(secs);
      if (meterRef.current) meterRef.current.style.transform = `scaleX(${rec.level()})`;
      if (secs >= maxSeconds) {
        onLimitRef.current();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [recording, maxSeconds]);

  // Resolves false when nothing started (already starting/recording or unmounted). Throws on mic errors.
  const start = useCallback(async (): Promise<boolean> => {
    if (startingRef.current || recRef.current) return false;
    startingRef.current = true;
    try {
      const rec = await startRecording();
      if (!mountedRef.current) {
        rec.cancel();
        return false;
      }
      recRef.current = rec;
      setElapsed(0);
      setRecording(true);
      return true;
    } finally {
      startingRef.current = false;
    }
  }, []);

  // Resolves null if there was no recording or the component unmounted meanwhile.
  const stop = useCallback(async (): Promise<Recording | null> => {
    const rec = recRef.current;
    if (!rec) return null;
    recRef.current = null;
    setRecording(false);
    const result = await rec.stop();
    if (!mountedRef.current) {
      URL.revokeObjectURL(result.url);
      return null;
    }
    return result;
  }, []);

  const isMounted = useCallback(() => mountedRef.current, []);
  // Synchronous check, so a manual stop racing the auto-stop only finishes once.
  const hasRecording = useCallback(() => recRef.current !== null, []);

  return { recording, elapsed, meterRef, start, stop, isMounted, hasRecording };
}
