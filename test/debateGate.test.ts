import assert from "node:assert/strict";
import test from "node:test";
import {
  getDebateStartBlockReason,
  hasDesignatedPresident,
  MISSING_SENATE_PRESIDENT_MESSAGE,
  TOO_FEW_ACTIVE_SENATORS_MESSAGE,
} from "../src/debateGate.js";

function activeSenator(id: string): { id: string } {
  return { id };
}

test("debate start is blocked when fewer than two active senators exist", () => {
  assert.equal(
    getDebateStartBlockReason([activeSenator("senator-1")], "senator-1"),
    TOO_FEW_ACTIVE_SENATORS_MESSAGE,
  );
});

test("debate start is blocked when no valid Senate President is designated", () => {
  const activeSenators = [activeSenator("senator-1"), activeSenator("senator-2")];

  assert.equal(hasDesignatedPresident(activeSenators, undefined), false);
  assert.equal(hasDesignatedPresident(activeSenators, "missing-president"), false);
  assert.equal(
    getDebateStartBlockReason(activeSenators, undefined),
    MISSING_SENATE_PRESIDENT_MESSAGE,
  );
  assert.equal(
    getDebateStartBlockReason(activeSenators, "missing-president"),
    MISSING_SENATE_PRESIDENT_MESSAGE,
  );
});

test("debate start is allowed only when the President is one of the active senators", () => {
  const activeSenators = [activeSenator("senator-1"), activeSenator("senator-2")];

  assert.equal(hasDesignatedPresident(activeSenators, "senator-2"), true);
  assert.equal(getDebateStartBlockReason(activeSenators, "senator-2"), null);
});
