export const DEBATE_MIN_ACTIVE_SENATORS = 2;
export const MISSING_SENATE_PRESIDENT_MESSAGE =
  "You must designate a Senate President (boss) before starting a debate. Please select one now.";
export const TOO_FEW_ACTIVE_SENATORS_MESSAGE =
  "The Senate requires at least 2 active AI models to debate. Use '/add' or '/preset' to continue.";

type ActiveSenatorRef = {
  id: string;
};

export function hasDesignatedPresident(
  activeSenators: readonly ActiveSenatorRef[],
  presidentId?: string,
): boolean {
  return Boolean(presidentId && activeSenators.some((senator) => senator.id === presidentId));
}

export function getDebateStartBlockReason(
  activeSenators: readonly ActiveSenatorRef[],
  presidentId?: string,
): string | null {
  if (activeSenators.length < DEBATE_MIN_ACTIVE_SENATORS) {
    return TOO_FEW_ACTIVE_SENATORS_MESSAGE;
  }

  if (!hasDesignatedPresident(activeSenators, presidentId)) {
    return MISSING_SENATE_PRESIDENT_MESSAGE;
  }

  return null;
}
