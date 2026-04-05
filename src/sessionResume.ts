import type { SessionChamberSnapshot, SessionData, SessionTurn } from "./config.js";

export type RestoredExecutionContext = {
  winnerId: string;
  turns: SessionTurn[];
};

export function deriveSessionRestoreState(session: SessionData): {
  lastConsensusOutput: string;
  lastExecutionContext: RestoredExecutionContext | null;
} {
  const lastTurn = session.turns[session.turns.length - 1];
  return {
    lastConsensusOutput: lastTurn?.consensusText ?? "",
    lastExecutionContext: lastTurn
      ? {
          winnerId: lastTurn.winnerId,
          turns: [...session.turns],
        }
      : null,
  };
}

export function createSessionChamberSnapshot(
  activeSenators: readonly Pick<{ id: string }, "id">[],
  presidentId?: string,
): SessionChamberSnapshot {
  return {
    activeSenatorIds: [...new Set(activeSenators.map((senator) => senator.id))].sort(),
    presidentId,
  };
}

export function chamberSnapshotsDiffer(
  savedSnapshot: SessionChamberSnapshot | undefined,
  currentSnapshot: SessionChamberSnapshot,
): boolean {
  if (!savedSnapshot) {
    return false;
  }

  if (savedSnapshot.presidentId !== currentSnapshot.presidentId) {
    return true;
  }

  const savedIds = [...new Set(savedSnapshot.activeSenatorIds)].sort();
  if (savedIds.length !== currentSnapshot.activeSenatorIds.length) {
    return true;
  }

  return savedIds.some((id, index) => id !== currentSnapshot.activeSenatorIds[index]);
}
