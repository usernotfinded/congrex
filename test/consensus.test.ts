import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  chooseWinner,
  buildCritiqueScores,
  buildVoteCounts,
  judgeWinnerRequiresImplementation,
  type AnswerRecord,
  type CritiqueRecord,
  type VoteRecord,
} from "../src/consensus.js";
import type { SenatorConfig } from "../src/config.js";

// ─── Test fixtures ──────────────────────────────────────────────────

function makeSenator(id: string, name: string): SenatorConfig {
  return { id, name, provider: "openai", modelId: "gpt-4o", active: true } as SenatorConfig;
}

function makeAnswer(senatorId: string, senatorName: string, answer = "test"): AnswerRecord {
  return { senatorId, senatorName, modelId: "gpt-4o", answer };
}

function makeVote(senatorId: string, winnerId: string): VoteRecord {
  return { senatorId, winnerId, reason: "better answer" };
}

function makeCritique(senatorId: string, targetId: string, score: number): CritiqueRecord {
  return { senatorId, targetId, strengths: "good", weaknesses: "none", score };
}

// ─── chooseWinner ───────────────────────────────────────────────────

describe("chooseWinner", () => {
  it("returns the only answer when there is a single senator", () => {
    const senators = [makeSenator("s1", "Alice")];
    const answers = [makeAnswer("s1", "Alice")];
    const result = chooseWinner(senators, answers, [], []);
    assert.equal(result.winnerId, "s1");
  });

  it("picks the answer with the most votes", () => {
    const senators = [makeSenator("s1", "Alice"), makeSenator("s2", "Bob"), makeSenator("s3", "Charlie")];
    const answers = [makeAnswer("s1", "Alice"), makeAnswer("s2", "Bob"), makeAnswer("s3", "Charlie")];
    const votes = [
      makeVote("s1", "s2"),
      makeVote("s2", "s2"),
      makeVote("s3", "s1"),
    ];
    const result = chooseWinner(senators, answers, votes, []);
    assert.equal(result.winnerId, "s2");
    assert.equal(result.tieBreakNote, undefined);
  });

  it("uses presidential tie-break when votes are tied", () => {
    const senators = [makeSenator("s1", "Alice"), makeSenator("s2", "Bob"), makeSenator("s3", "Charlie")];
    const answers = [makeAnswer("s1", "Alice"), makeAnswer("s2", "Bob"), makeAnswer("s3", "Charlie")];
    const votes = [
      makeVote("s1", "s2"),
      makeVote("s2", "s1"),
      makeVote("s3", "s3"),
    ];
    // president is s1, tied 3-way → presidential seniority picks s1 (first in config)
    const result = chooseWinner(senators, answers, votes, [], "s1");
    assert.ok(result.tieBreakNote);
  });

  it("uses critique scores for 2-senator chambers with no votes", () => {
    const senators = [makeSenator("s1", "Alice"), makeSenator("s2", "Bob")];
    const answers = [makeAnswer("s1", "Alice"), makeAnswer("s2", "Bob")];
    const critiques = [
      makeCritique("s1", "s2", 3),
      makeCritique("s2", "s1", 5),
    ];
    const result = chooseWinner(senators, answers, [], critiques);
    assert.equal(result.winnerId, "s1"); // s1 got score 5, s2 got score 3
  });

  it("throws when >2 senators have no votes", () => {
    const senators = [makeSenator("s1", "A"), makeSenator("s2", "B"), makeSenator("s3", "C")];
    const answers = [makeAnswer("s1", "A"), makeAnswer("s2", "B"), makeAnswer("s3", "C")];
    assert.throws(
      () => chooseWinner(senators, answers, [], []),
      /no valid votes/i,
    );
  });
});

// ─── buildCritiqueScores ────────────────────────────────────────────

describe("buildCritiqueScores", () => {
  it("sums critique scores per target", () => {
    const answers = [makeAnswer("s1", "A"), makeAnswer("s2", "B")];
    const critiques = [
      makeCritique("s1", "s2", 3),
      makeCritique("s2", "s1", 5),
      makeCritique("s3", "s1", 2), // from non-answering senator
    ];
    const scores = buildCritiqueScores(answers, critiques);
    assert.equal(scores.get("s1"), 7);
    assert.equal(scores.get("s2"), 3);
  });

  it("ignores critiques targeting unknown senators", () => {
    const answers = [makeAnswer("s1", "A")];
    const critiques = [makeCritique("s2", "s9", 10)];
    const scores = buildCritiqueScores(answers, critiques);
    assert.equal(scores.get("s1"), 0);
  });
});

// ─── buildVoteCounts ────────────────────────────────────────────────

describe("buildVoteCounts", () => {
  it("counts votes per winner", () => {
    const answers = [makeAnswer("s1", "A"), makeAnswer("s2", "B")];
    const votes = [makeVote("s1", "s2"), makeVote("s2", "s2"), makeVote("s3", "s1")];
    const counts = buildVoteCounts(answers, votes);
    assert.equal(counts.get("s1"), 1);
    assert.equal(counts.get("s2"), 2);
  });

  it("ignores votes for unknown winners", () => {
    const answers = [makeAnswer("s1", "A")];
    const votes = [makeVote("s2", "s9")];
    const counts = buildVoteCounts(answers, votes);
    assert.equal(counts.get("s1"), 0);
  });
});

// ─── judgeWinnerRequiresImplementation ──────────────────────────────

describe("judgeWinnerRequiresImplementation", () => {
  it("returns true for answers containing file directives", () => {
    assert.ok(judgeWinnerRequiresImplementation("You should modify the code in src/index.ts to fix this."));
  });

  it("returns true for create file directives", () => {
    assert.ok(judgeWinnerRequiresImplementation("Create a new file called utils.ts."));
  });

  it("returns true for change verb + code target", () => {
    assert.ok(judgeWinnerRequiresImplementation("Add a new function to handle authentication."));
  });

  it("returns false for advisory/informational answers", () => {
    assert.ok(!judgeWinnerRequiresImplementation("The best approach is to use a queue-based architecture."));
  });

  it("returns false for pure comparison answers", () => {
    assert.ok(!judgeWinnerRequiresImplementation("React is faster than Angular for this use case."));
  });
});
