/**
 * MimirPayUSD's EIP-3009 surface, checked against its compiled source.
 *
 * x402's `exact` scheme pays by signature, so this token is the thing that makes
 * paid routes possible at all on a chain whose collateral has no EIP-3009, no
 * permit and no Permit2. The properties below are the ones that decide whether a
 * signed authorization can be stolen, replayed, or spent after it should have
 * expired — none of which a compile catches.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("../../contracts/MimirPayUSD.sol", import.meta.url), "utf8");

function body(signature: string, until: string): string {
  const start = SOURCE.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const end = SOURCE.indexOf(until, start);
  assert.ok(end > start, `end marker for ${signature} not found`);
  return SOURCE.slice(start, end);
}

test("the EIP-712 type hashes match the EIP-3009 specification exactly", () => {
  // A single character off here and every wallet's signature recovers to a
  // different address — the token would simply reject every real payment.
  assert.match(
    SOURCE,
    /TransferWithAuthorization\(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce\)/,
  );
  assert.match(
    SOURCE,
    /ReceiveWithAuthorization\(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce\)/,
  );
  assert.match(SOURCE, /CancelAuthorization\(address authorizer,bytes32 nonce\)/);
  assert.match(
    SOURCE,
    /EIP712Domain\(string name,string version,uint256 chainId,address verifyingContract\)/,
  );
});

test("an authorization is single-use, and is burned before the tokens move", () => {
  const transfer = body("function transferWithAuthorization(", "function receiveWithAuthorization(");
  const markAt = transfer.indexOf("_markAuthorizationUsed");
  const moveAt = transfer.indexOf("_transfer(from, to, value)");
  assert.ok(markAt > 0 && moveAt > markAt, "the nonce must be spent before the transfer");

  // And the guard that makes a second submission fail.
  const guard = body("function _requireValidAuthorization(", "function _markAuthorizationUsed(");
  assert.match(guard, /!authorizationState\[authorizer\]\[nonce\]/);
});

test("validAfter and validBefore are both enforced, exclusively", () => {
  const guard = body("function _requireValidAuthorization(", "function _markAuthorizationUsed(");
  assert.match(guard, /block\.timestamp > validAfter/);
  assert.match(guard, /block\.timestamp < validBefore/);
});

test("receiveWithAuthorization can only be submitted by the payee", () => {
  // Without this, anyone watching the mempool can choose when a recipient gets
  // paid, which is the whole reason the spec separates the two calls.
  const receive = body("function receiveWithAuthorization(", "/** Burn an unused nonce");
  assert.match(receive, /require\(to == msg\.sender/);
});

test("signature checks reject the malleable half of the curve and a bad v", () => {
  const check = body("function _requireValidSignature(", "\n}");
  assert.match(check, /0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0/);
  assert.match(check, /v == 27 \|\| v == 28/);
  // ecrecover returns the zero address on failure; treating that as a match
  // would let an unsigned payload pass as a payment from address(0).
  assert.match(check, /recovered != address\(0\) && recovered == signer/);
});

test("the domain separator is rebuilt when the chain id changes", () => {
  // A cached separator makes every signature replayable on a fork.
  const domain = body("function DOMAIN_SEPARATOR()", "// ── ERC-20");
  assert.match(domain, /block\.chainid == _cachedChainId/);
});

test("cancelling a nonce requires the authorizer's own signature", () => {
  const cancel = body("function cancelAuthorization(", "function _requireValidAuthorization(");
  assert.match(cancel, /_requireValidSignature\(\s*authorizer,/);
  assert.match(cancel, /authorizationState\[authorizer\]\[nonce\] = true/);
});

test("minting is restricted, and six decimals match the venue's collateral", () => {
  assert.match(SOURCE, /uint8\s+public constant decimals = 6;/);
  const mint = body("function mint(address to, uint256 value)", "function setMinter(");
  assert.match(mint, /msg\.sender == minter/);
  const setMinter = body("function setMinter(address next)", "// ── EIP-3009");
  assert.match(setMinter, /msg\.sender == minter/);
});
