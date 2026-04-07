/**
 * Consensus / Winner-selection logic — extracted from index.ts for
 * testability and maintainability.
 *
 * Pure functions: no I/O, no global state.
 */

import type { SenatorConfig } from "./config.js";

// ─── Domain types ──────────────────────────────────────────────────

export type AnswerRecord = {
  senatorId: string;
  senatorName: string;
  modelId: string;
  answer: string;
};

export type CritiqueRecord = {
  senatorId: string;
  targetId: string;
  strengths: string;
  weaknesses: string;
  score: number;
};

export type VoteRecord = {
  senatorId: string;
  winnerId: string;
  reason: string;
};

export type WinnerSelection = {
  winner: AnswerRecord;
  winnerId: string;
  tieBreakNote?: string;
};

// ─── Helpers ───────────────────────────────────────────────────────

export function buildConfigOrder(senators: SenatorConfig[]): Map<string, number> {
  return new Map(senators.map((senator, index) => [senator.id, index]));
}

export function buildCritiqueScores(answers: AnswerRecord[], critiques: CritiqueRecord[]): Map<string, number> {
  const scores = new Map(answers.map((answer) => [answer.senatorId, 0]));

  for (const critique of critiques) {
    if (!scores.has(critique.targetId)) {
      continue;
    }

    scores.set(critique.targetId, (scores.get(critique.targetId) || 0) + critique.score);
  }

  return scores;
}

export function buildVoteCounts(answers: AnswerRecord[], votes: VoteRecord[]): Map<string, number> {
  const counts = new Map(answers.map((answer) => [answer.senatorId, 0]));

  for (const vote of votes) {
    if (!counts.has(vote.winnerId)) {
      continue;
    }

    counts.set(vote.winnerId, (counts.get(vote.winnerId) || 0) + 1);
  }

  return counts;
}

export function pickFirstByConfiguration(candidateIds: string[], configOrder: Map<string, number>): string | undefined {
  return [...candidateIds].sort((left, right) => (configOrder.get(left) || Number.MAX_SAFE_INTEGER) - (configOrder.get(right) || Number.MAX_SAFE_INTEGER))[0];
}

export function resolveTieByPresidentialRule(
  tiedCandidateIds: string[],
  senators: SenatorConfig[],
  votes: VoteRecord[],
  answerById: Map<string, AnswerRecord>,
  presidentId?: string,
): WinnerSelection {
  const configOrder = buildConfigOrder(senators);
  const president = (presidentId ? senators.find((s) => s.id === presidentId) : undefined) || senators[0];
  const presidentVote = votes.find((vote) => vote.senatorId === president?.id);
  const presidentIsTied = Boolean(president && tiedCandidateIds.includes(president.id));

  let winnerId: string | undefined =
    presidentIsTied && presidentVote && tiedCandidateIds.includes(presidentVote.winnerId)
      ? presidentVote.winnerId
      : pickFirstByConfiguration(tiedCandidateIds, configOrder);

  if (winnerId && !answerById.has(winnerId)) {
    winnerId = pickFirstByConfiguration(
      tiedCandidateIds.filter((candidateId) => answerById.has(candidateId)),
      configOrder,
    );
  }

  const winner = winnerId ? answerById.get(winnerId) : undefined;
  if (!winner || !winnerId) {
    const fallbackId = pickFirstByConfiguration([...answerById.keys()], configOrder);
    const fallbackWinner = fallbackId ? answerById.get(fallbackId) : undefined;
    if (!fallbackWinner) {
      throw new Error("No valid tied winner could be resolved.");
    }

    return {
      winner: fallbackWinner,
      winnerId: fallbackWinner.senatorId,
      tieBreakNote: `Tie-break applied: ${fallbackWinner.senatorName} designated as winner by Presidential Seniority.`,
    };
  }

  return {
    winner,
    winnerId,
    tieBreakNote: `Tie-break applied: ${winner.senatorName} designated as winner by Presidential Seniority.`,
  };
}

export function chooseWinner(
  senators: SenatorConfig[],
  answers: AnswerRecord[],
  votes: VoteRecord[],
  critiques: CritiqueRecord[],
  presidentId?: string,
): WinnerSelection {
  const answerById = new Map(answers.map((answer) => [answer.senatorId, answer]));

  if (answers.length === 1) {
    return {
      winner: answers[0],
      winnerId: answers[0].senatorId,
    };
  }

  if (votes.length === 0) {
    if (answers.length > 2) {
      throw new Error("No consensus: no valid votes were cast in round 3.");
    }

    const critiqueScores = buildCritiqueScores(answers, critiques);
    const topScore = Math.max(...answers.map((answer) => critiqueScores.get(answer.senatorId) || 0));
    const tiedCandidates = answers.filter((answer) => (critiqueScores.get(answer.senatorId) || 0) === topScore);

    if (tiedCandidates.length === 1) {
      return {
        winner: tiedCandidates[0],
        winnerId: tiedCandidates[0].senatorId,
      };
    }

    return resolveTieByPresidentialRule(
      tiedCandidates.map((answer) => answer.senatorId),
      senators,
      votes,
      answerById,
      presidentId,
    );
  }

  const voteCounts = buildVoteCounts(answers, votes);
  const topVoteCount = Math.max(...answers.map((answer) => voteCounts.get(answer.senatorId) || 0));
  const tiedCandidates = answers.filter((answer) => (voteCounts.get(answer.senatorId) || 0) === topVoteCount);

  if (tiedCandidates.length === 1) {
    return {
      winner: tiedCandidates[0],
      winnerId: tiedCandidates[0].senatorId,
    };
  }

  return resolveTieByPresidentialRule(
    tiedCandidates.map((answer) => answer.senatorId),
    senators,
    votes,
    answerById,
    presidentId,
  );
}

// ─── Judge heuristic ───────────────────────────────────────────────

export function judgeWinnerRequiresImplementation(answer: string): boolean {
  const hasChangeVerb = /\b(add|create|modify|replace|refactor|delete|implement|rename|remove|update|edit|patch|write)\b/i.test(answer);
  const hasCodeTarget = /\b(file|function|class|method|component|module|route|endpoint|test|feature|code|codebase)\b/i.test(answer);
  const hasPathLikeTarget = /\b[a-z0-9_./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|cpp|c|h|hpp|json|yml|yaml|md)\b/i.test(answer);
  const hasFileDirective = /\b(in|into|inside)\s+[a-z0-9_./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|cpp|c|h|hpp|json|yml|yaml|md)\b/i.test(answer);
  const hasCreateFileDirective = /\b(create|add|write)\b.{0,30}\b(new )?file\b/i.test(answer);
  const hasNamedCodeBlock = /```[^\n]*\n(?:.*\n){0,3}(?:file|path)\s*:/i.test(answer);

  return hasFileDirective || hasCreateFileDirective || hasNamedCodeBlock || (hasChangeVerb && (hasCodeTarget || hasPathLikeTarget));
}
