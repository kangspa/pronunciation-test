import { useCallback, useEffect, useState } from 'react';
import { addAttempt, deleteAttempt, listAttempts } from '../lib/attemptStore';
import type { Attempt } from '../lib/attemptStore';

// Attempt records of one twister or song, newest first. Saving failures are
// reported but never block showing the result of the attempt itself.
export function useAttempts(item: string) {
  const [attempts, setAttempts] = useState<Attempt[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listAttempts(item)
      .then((list) => {
        if (!cancelled) setAttempts(list);
      })
      .catch(() => {
        if (!cancelled) {
          setAttempts([]);
          setError('이 브라우저에서는 연습 기록을 불러올 수 없어요.');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [item]);

  const add = useCallback(async (a: Attempt) => {
    setAttempts((prev) => [a, ...(prev ?? [])]);
    try {
      await addAttempt(a);
      setError(null);
    } catch {
      setError('기록을 저장하지 못했어요. 저장 공간이 부족하거나 브라우저가 저장을 막고 있어요.');
    }
  }, []);

  const remove = useCallback(async (a: Attempt) => {
    try {
      await deleteAttempt(a.id);
      setAttempts((prev) => prev?.filter((x) => x.id !== a.id) ?? null);
    } catch {
      setError('기록을 삭제하지 못했어요.');
    }
  }, []);

  return { attempts, error, add, remove };
}
