import assert from "node:assert/strict";
import test from "node:test";
import {
  chamberSnapshotsDiffer,
  createSessionChamberSnapshot,
  deriveSessionRestoreState,
} from "../src/sessionResume.js";
import { createEmptySession } from "../src/config.js";

test("deriveSessionRestoreState safely restores empty sessions", () => {
  const session = createEmptySession("empty");

  assert.deepEqual(deriveSessionRestoreState(session), {
    lastConsensusOutput: "",
    lastExecutionContext: null,
  });
});

test("deriveSessionRestoreState uses the last turn for consensus and execution context", () => {
  const session = createEmptySession("with-turns");
  session.turns.push(
    {
      userPrompt: "first prompt",
      consensusText: "first answer",
      winnerId: "senator-1",
    },
    {
      userPrompt: "second prompt",
      consensusText: "second answer",
      winnerId: "senator-2",
    },
  );

  assert.deepEqual(deriveSessionRestoreState(session), {
    lastConsensusOutput: "second answer",
    lastExecutionContext: {
      winnerId: "senator-2",
      turns: [...session.turns],
    },
  });
});

test("chamberSnapshotsDiffer returns false for equivalent chambers", () => {
  const savedSnapshot = {
    activeSenatorIds: ["senator-2", "senator-1", "senator-1"],
    presidentId: "senator-2",
  };
  const currentSnapshot = createSessionChamberSnapshot(
    [{ id: "senator-1" }, { id: "senator-2" }],
    "senator-2",
  );

  assert.equal(chamberSnapshotsDiffer(savedSnapshot, currentSnapshot), false);
});

test("chamberSnapshotsDiffer detects president and roster changes", () => {
  const savedSnapshot = {
    activeSenatorIds: ["senator-1", "senator-2"],
    presidentId: "senator-2",
  };

  assert.equal(
    chamberSnapshotsDiffer(savedSnapshot, createSessionChamberSnapshot([{ id: "senator-1" }, { id: "senator-2" }], "senator-1")),
    true,
  );
  assert.equal(
    chamberSnapshotsDiffer(savedSnapshot, createSessionChamberSnapshot([{ id: "senator-1" }, { id: "senator-3" }], "senator-2")),
    true,
  );
});
