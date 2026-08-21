import assert from "node:assert/strict";
import test from "node:test";

import {
  isDetected,
  kindOf,
  labelFor,
  shapeConnectors,
  subtitleFor,
} from "../../lib/wallet-connectors";

// Shapes as wagmi 3 actually reports them, ids included.
const STANDARD = { id: "standardWallet", name: "Browser Wallet" };
const METAMASK_SDK = { id: "metaMaskSDK", name: "MetaMask", type: "injected" };
const METAMASK_6963 = { id: "io.metamask", name: "MetaMask", type: "injected", icon: "data:image/svg+xml,mm" };
const COINBASE = { id: "coinbaseWalletSDK", name: "Coinbase Wallet" };
const PHANTOM = { id: "app.phantom", name: "Phantom", type: "injected" };
const GENERIC = { id: "injected", name: "Browser Wallet", type: "injected" };
const WC = { id: "walletConnect", name: "WalletConnect" };

test("recent wallets are offered first", () => {
  const order = shapeConnectors([WC, METAMASK_6963, COINBASE, STANDARD], { recentId: "standardWallet" }).map((c) => c.id);
  assert.equal(order[0], "standardWallet");
});

test("the QR gateway sorts last, below every real wallet", () => {
  const order = shapeConnectors([WC, METAMASK_6963, COINBASE]).map((c) => c.id);
  assert.equal(order.at(-1), "walletConnect");
});

test("the wallet used last is promoted above other wallets", () => {
  const order = shapeConnectors([STANDARD, METAMASK_6963, COINBASE, PHANTOM], {
    recentId: "app.phantom",
  }).map((c) => c.id);
  assert.deepEqual(order.slice(0, 2), ["app.phantom", "io.metamask"]);
});

test("one wallet is one row even when wagmi lists it twice", () => {
  // metaMask() and EIP-6963 discovery both report MetaMask; two rows read as a bug.
  const rows = shapeConnectors([METAMASK_SDK, METAMASK_6963]);
  assert.equal(rows.length, 1);
  // The surviving row keeps the brand mark from whichever duplicate carried it.
  assert.equal(rows[0].icon, "data:image/svg+xml,mm");
});

test("dedupe keeps a recent flag that arrived on the losing duplicate", () => {
  const rows = shapeConnectors([METAMASK_6963, METAMASK_SDK], { recentId: "metaMaskSDK" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].recent, true);
});

test("only an actually-installed wallet counts as detected", () => {
  assert.equal(isDetected(PHANTOM), true);
  // The catch-all injected entry has no discovered provider behind it.
  assert.equal(isDetected(GENERIC), false);
  assert.equal(isDetected(COINBASE), false);
});

test("kinds are matched on substrings, not exact connector ids", () => {
  // These ids drift between wagmi and SDK versions, so only stable categories
  // are used for ordering.
  assert.equal(kindOf({ id: "xyz", name: "Browser Wallet" }), "sdk");
  assert.equal(kindOf({ id: "walletConnectV2", name: "WalletConnect" }), "walletConnect");
  assert.equal(kindOf(PHANTOM), "injected");
  assert.equal(kindOf(COINBASE), "sdk");
});

test("the QR row is labelled as a gateway, not as a wallet", () => {
  const [wc] = shapeConnectors([WC]);
  assert.equal(labelFor(wc), "Scan QR");
  assert.equal(subtitleFor(wc), "380+ mobile wallets");
});

test("a wallet with no icon still gets a monogram", () => {
  const [phantom] = shapeConnectors([PHANTOM]);
  assert.equal(phantom.monogram, "P");
});
