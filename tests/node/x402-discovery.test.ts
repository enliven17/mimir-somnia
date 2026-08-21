import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MAX_ADVERTISED_CAPABILITIES,
  admitDiscovered,
  admitDiscoveredBatch,
  parseAdvertisedPrice,
  type DiscoveryPolicy,
} from "../../lib/x402/discovery";

const POLICY: DiscoveryPolicy = {
  maxPriceUnits: 10_000n, // $0.01
  wantedCapabilities: ["price", "weather"],
  maxAdvertisedCapabilities: DEFAULT_MAX_ADVERTISED_CAPABILITIES,
};

function listing(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://api.example.org/price",
    price: "$0.001",
    capabilities: ["price"],
    serviceName: "Example price feed",
    ...overrides,
  };
}

// ── URL safety ────────────────────────────────────────────────────────────────

test("a discovered endpoint pointing at cloud metadata is refused", () => {
  // The cheapest possible attack: publish a Bazaar listing for 169.254.169.254.
  const verdict = admitDiscovered(listing({ url: "http://169.254.169.254/latest/meta-data/" }), POLICY);
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.reason, "unsafe_url");
});

test("localhost and private ranges are refused", () => {
  for (const url of [
    "http://localhost:3000/x",
    "http://127.0.0.1/x",
    "http://10.0.0.5/x",
    "http://192.168.1.1/x",
  ]) {
    assert.equal(admitDiscovered(listing({ url }), POLICY).reason, "unsafe_url", url);
  }
});

test("a file URL is refused", () => {
  assert.equal(admitDiscovered(listing({ url: "file:///etc/passwd" }), POLICY).reason, "unsafe_url");
});

test("a domain allowlist narrows discovery without a deploy", () => {
  const narrowed: DiscoveryPolicy = {
    ...POLICY,
    domainPolicy: { allow: ["trusted.example"], deny: [] },
  };
  assert.equal(admitDiscovered(listing(), narrowed).reason, "domain_not_allowed");
  assert.equal(
    admitDiscovered(listing({ url: "https://api.trusted.example/price" }), narrowed).admitted,
    true,
  );
});

test("a deny entry beats an allow entry", () => {
  const policy: DiscoveryPolicy = {
    ...POLICY,
    domainPolicy: { allow: ["example.org"], deny: ["api.example.org"] },
  };
  assert.equal(admitDiscovered(listing(), policy).reason, "domain_not_allowed");
});

// ── Price ─────────────────────────────────────────────────────────────────────

test("an unpriced endpoint is refused rather than treated as free", () => {
  assert.equal(admitDiscovered(listing({ price: undefined }), POLICY).reason, "price_missing");
});

test("a price above the cap is refused", () => {
  const verdict = admitDiscovered(listing({ price: "$5.00" }), POLICY);
  assert.equal(verdict.reason, "price_above_cap");
});

test("a price exactly at the cap is admitted", () => {
  assert.equal(admitDiscovered(listing({ price: "$0.01" }), POLICY).admitted, true);
});

test("a price we cannot parse is a refusal, not a guess", () => {
  // The seller writes this string; a lenient parse is a way to be charged a number
  // nobody read.
  for (const price of ["free", "0.001 ETH", "1e-3", "$0.0000001", "-1", "$$1", ""]) {
    assert.equal(
      admitDiscovered(listing({ price }), POLICY).reason,
      "price_unparseable",
      `accepted ${JSON.stringify(price)}`,
    );
  }
});

test("prices parse to USDC atomic units", () => {
  assert.equal(parseAdvertisedPrice("$0.001"), 1_000n);
  assert.equal(parseAdvertisedPrice("1"), 1_000_000n);
  assert.equal(parseAdvertisedPrice("$0"), 0n);
  assert.equal(parseAdvertisedPrice("0.000001"), 1n);
  assert.equal(parseAdvertisedPrice(undefined), null);
});

test("the admitted price is returned so the caller caps the actual payment", () => {
  // The buyer budget policy needs the number, not just permission.
  const verdict = admitDiscovered(listing({ price: "$0.005" }), POLICY);
  assert.equal(verdict.priceUnits, 5_000n);
});

// ── Capabilities ──────────────────────────────────────────────────────────────

test("an endpoint offering something we did not ask for is refused", () => {
  const verdict = admitDiscovered(listing({ capabilities: ["image-generation"] }), POLICY);
  assert.equal(verdict.reason, "capability_not_requested");
});

test("capability matching is case-insensitive and trims", () => {
  assert.equal(admitDiscovered(listing({ capabilities: ["  PRICE "] }), POLICY).admitted, true);
});

test("a listing claiming to do everything is refused", () => {
  // Forty tags is keyword-matching for discovery traffic, not a service.
  const many = Array.from({ length: 40 }, (_, i) => `cap${i}`).concat("price");
  assert.equal(
    admitDiscovered(listing({ capabilities: many }), POLICY).reason,
    "too_many_capabilities",
  );
});

test("an empty wanted list refuses everything rather than admitting everything", () => {
  // A misconfigured policy has to fail closed.
  const verdict = admitDiscovered(listing(), { ...POLICY, wantedCapabilities: [] });
  assert.equal(verdict.admitted, false);
  assert.equal(verdict.reason, "capability_not_requested");
});

test("a listing with no capabilities at all is refused", () => {
  assert.equal(
    admitDiscovered(listing({ capabilities: undefined }), POLICY).reason,
    "capability_not_requested",
  );
});

// ── MIME ──────────────────────────────────────────────────────────────────────

test("an unexpected content type is refused when types are configured", () => {
  const policy: DiscoveryPolicy = { ...POLICY, acceptedMimeTypes: ["application/json"] };
  assert.equal(
    admitDiscovered(listing({ mimeType: "text/html" }), policy).reason,
    "mime_not_accepted",
  );
  assert.equal(admitDiscovered(listing({ mimeType: "application/json" }), policy).admitted, true);
});

test("a missing content type is refused when types are configured", () => {
  const policy: DiscoveryPolicy = { ...POLICY, acceptedMimeTypes: ["application/json"] };
  assert.equal(admitDiscovered(listing(), policy).reason, "mime_not_accepted");
});

// ── Batch ─────────────────────────────────────────────────────────────────────

test("a batch reports why each rejection happened", () => {
  // A caller must be able to log why reach narrowed, not just see fewer sources.
  const { admitted, rejected } = admitDiscoveredBatch(
    [
      listing(),
      listing({ url: "http://127.0.0.1/x" }),
      listing({ price: "$9.00", url: "https://b.example.org/p" }),
    ],
    POLICY,
  );
  assert.equal(admitted.length, 1);
  assert.deepEqual(rejected.map((r) => r.verdict.reason), ["unsafe_url", "price_above_cap"]);
});

test("the same endpoint listed twice is one endpoint", () => {
  // Otherwise a seller fills the whole result set with itself.
  const { admitted } = admitDiscoveredBatch(
    [listing({ serviceName: "A" }), listing({ serviceName: "B" })],
    POLICY,
  );
  assert.equal(admitted.length, 1);
});

test("deduplication ignores case in the URL", () => {
  const { admitted } = admitDiscoveredBatch(
    [listing(), listing({ url: "HTTPS://API.EXAMPLE.ORG/price" })],
    POLICY,
  );
  assert.equal(admitted.length, 1);
});

test("cheapest is first, with a stable tiebreak", () => {
  const { admitted } = admitDiscoveredBatch(
    [
      listing({ url: "https://c.example.org/p", price: "$0.005" }),
      listing({ url: "https://a.example.org/p", price: "$0.001" }),
      listing({ url: "https://b.example.org/p", price: "$0.001" }),
    ],
    POLICY,
  );
  assert.deepEqual(
    admitted.map((r) => r.url),
    ["https://a.example.org/p", "https://b.example.org/p", "https://c.example.org/p"],
  );
});

test("an empty discovery response admits nothing and throws nothing", () => {
  const { admitted, rejected } = admitDiscoveredBatch([], POLICY);
  assert.equal(admitted.length, 0);
  assert.equal(rejected.length, 0);
});
