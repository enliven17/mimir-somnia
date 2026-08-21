import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../contracts/MimirV2.sol", import.meta.url), "utf8");

test("stake intake rejects fee-on-transfer and rebasing token behavior", () => {
  assert.match(source, /uint256 beforeBalance = usdc\.balanceOf\(address\(this\)\)/);
  assert.match(source, /beforeBalance \+ amount, "Mimir: unsupported token"/);
});

test("fee claiming uses checks-effects-interactions behind the reentrancy guard", () => {
  const claimFees = source.slice(source.indexOf("function claimFees()"), source.indexOf("// ── Write: create"));
  assert.match(claimFees, /external nonReentrant/);
  const clearAt = claimFees.indexOf("accruedFees[msg.sender] = 0");
  const transferAt = claimFees.indexOf("usdc.transfer(msg.sender, amount)");
  assert.ok(clearAt >= 0 && transferAt > clearAt, "balance must clear before token interaction");
});

test("settlement accrues fees instead of calling recipients", () => {
  const applyFees = source.slice(source.indexOf("function _applyFees("), source.indexOf("// ── Withdrawals"));
  assert.match(applyFees, /accruedFees\[fees\.platformRecipient\] \+= platformFee/);
  assert.doesNotMatch(applyFees, /\.call\(|\.transfer\(/);
});
