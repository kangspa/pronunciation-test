import { useSyncExternalStore } from 'react';
import { asrClient } from './asrClient';

export function useModelState() {
  return useSyncExternalStore(asrClient.subscribe, asrClient.getState);
}
