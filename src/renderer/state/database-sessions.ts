import { useCallback, useEffect, useState } from 'react';
import type { DatabaseSessionDescriptor } from '@shared/database';
import type { AppError } from '@shared/contracts';

export type DatabaseConnectionState =
  | { phase: 'connecting' }
  | { phase: 'ready'; session: DatabaseSessionDescriptor }
  | { phase: 'error'; error: AppError };

export function useDatabaseSession(profileId: string) {
  const [state, setState] = useState<DatabaseConnectionState>({ phase: 'connecting' });
  const [revision, setRevision] = useState(0);
  const reconnect = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    let sessionId: string | undefined;
    setState({ phase: 'connecting' });
    void window.productivityApi.database.connect({ profileId }).then((result) => {
      if (!active) {
        if (result.ok) void window.productivityApi.database.close({ sessionId: result.value.sessionId });
        return;
      }
      if (result.ok) {
        sessionId = result.value.sessionId;
        setState({ phase: 'ready', session: result.value });
      } else setState({ phase: 'error', error: result.error });
    });
    return () => {
      active = false;
      if (sessionId) void window.productivityApi.database.close({ sessionId });
    };
  }, [profileId, revision]);
  return { state, reconnect };
}
