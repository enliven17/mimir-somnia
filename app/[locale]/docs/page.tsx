import type { ReactNode } from "react";

import { getExplorerAddressUrl, somniaShannon } from "@/lib/chain";
import { DREAMDEX_ADDRESSES, DREAMDEX_NETWORK } from "@/lib/dreamdex";

/**
 * The handbook.
 *
 * Section numbers are read from this one list rather than written next to each
 * heading. Carrying the number twice is how a sidebar ends up saying 07 while
 * the heading under it says 06, with nothing to catch it — so the sidebar, the
 * headings and the anchors all count from here.
 *
 * tests/node/docs-contents.test.ts holds that contract: every rendered section
 * appears here, in the same order, with unique ids.
 *
 * Deliberately free of chain reads. An earlier revision of the stats page
 * scanned logs while rendering and took minutes to answer; documentation must
 * be the fastest page on the site, so everything below is either static or
 * comes from a compile-time constant.
 */
const TOC_SECTIONS = [
  { id: "overview", title: "What Mimir is" },
  { id: "network", title: "Network and addresses" },
  { id: "venues", title: "Two venues" },
  { id: "dreamdex", title: "Inside DreamDEX" },
  { id: "market-lifecycle", title: "Life of a market" },
  { id: "agents", title: "The agent fabric" },
  { id: "council", title: "How the council decides" },
  { id: "trading", title: "Placing a trade" },
  { id: "settlement", title: "Settlement and payout" },
  { id: "wallets", title: "Wallets and sign-in" },
  { id: "payments", title: "Paid endpoints (x402)" },
  { id: "data", title: "Where the data lives" },
  { id: "api", title: "HTTP API" },
  { id: "deployment", title: "Deployment" },
  { id: "local", title: "Running it yourself" },
  { id: "troubleshooting", title: "Troubleshooting" },
] as const;

type SectionId = (typeof TOC_SECTIONS)[number]["id"];

function sectionNumber(id: SectionId): string {
  const index = TOC_SECTIONS.findIndex((section) => section.id === id);
  return String(index + 1).padStart(2, "0");
}

function sectionTitle(id: SectionId): string {
  return TOC_SECTIONS.find((section) => section.id === id)?.title ?? id;
}

// ── Page furniture ───────────────────────────────────────────────────────────

function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-pv-border/25 pt-10">
      <div className="flex items-baseline gap-3">
        <span aria-hidden className="font-mono text-xs text-pv-emerald">
          {sectionNumber(id)}
        </span>
        <h2 className="font-display text-2xl font-bold tracking-tight text-pv-text sm:text-3xl">
          <a href={`#${id}`} className="hover:text-pv-emerald">
            {sectionTitle(id)}
          </a>
        </h2>
      </div>
      <div className="mt-5 space-y-4 text-[15px] leading-7 text-pv-muted">{children}</div>
    </section>
  );
}

function Sub({ children }: { children: ReactNode }) {
  return (
    <h3 className="pt-3 font-display text-lg font-semibold text-pv-text">{children}</h3>
  );
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-pv-surface2 px-1.5 py-0.5 font-mono text-[13px] text-pv-text">
      {children}
    </code>
  );
}

function Block({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto rounded border border-pv-border/30 bg-pv-bg p-4 font-mono text-xs leading-6 text-pv-muted">
      {children}
    </pre>
  );
}

function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="space-y-3">
      {items.map((item, index) => (
        <li key={index} className="flex gap-3">
          <span
            aria-hidden
            className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full border border-pv-emerald/40 font-mono text-[11px] text-pv-emerald"
          >
            {index + 1}
          </span>
          <span className="min-w-0 flex-1">{item}</span>
        </li>
      ))}
    </ol>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <aside className="border-l-2 border-pv-emerald/50 bg-pv-surface/60 py-3 pl-4 pr-3 text-sm">
      {children}
    </aside>
  );
}

function Figure({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <figure className="my-6">
      <div className="overflow-x-auto rounded border border-pv-border/30 bg-pv-surface/50 p-4">
        {children}
      </div>
      <figcaption className="mt-2 font-mono text-[11px] uppercase tracking-wider text-pv-muted">
        {caption}
      </figcaption>
    </figure>
  );
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-pv-border/40">
            {head.map((cell) => (
              <th
                key={cell}
                className="py-2 pr-4 font-mono text-[11px] uppercase tracking-wider text-pv-muted"
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index} className="border-b border-pv-border/20 align-top">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="py-2.5 pr-4 text-pv-muted">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Diagrams ─────────────────────────────────────────────────────────────────
// Inline SVG rather than an image: these must read in both themes, so every
// stroke and fill is a palette token, and text is real text a reader can select
// and a screen reader can reach through the figure caption.

const BOX = "fill-pv-surface2 stroke-pv-border";
const BOX_ACCENT = "fill-pv-surface2 stroke-pv-emerald";
const LABEL = "fill-pv-text font-[600]";
const MUTED = "fill-pv-muted";

function Arrow() {
  return (
    <defs>
      <marker
        id="doc-arrow"
        viewBox="0 0 10 10"
        refX="9"
        refY="5"
        markerWidth="6"
        markerHeight="6"
        orient="auto-start-reverse"
      >
        <path d="M 0 0 L 10 5 L 0 10 z" className="fill-pv-border" />
      </marker>
    </defs>
  );
}

const LINE = "stroke-pv-border";

function VenuesDiagram() {
  return (
    <svg viewBox="0 0 640 250" className="h-auto w-full min-w-[560px]" role="img"
      aria-label="Mimir's two venues: DreamDEX binary markets and VS claims on the Mimir contract">
      <Arrow />
      <rect x="240" y="12" width="160" height="38" rx="4" className={BOX_ACCENT} strokeWidth="1" />
      <text x="320" y="36" textAnchor="middle" className={LABEL} fontSize="13">Mimir app</text>

      <line x1="300" y1="50" x2="150" y2="86" className={LINE} markerEnd="url(#doc-arrow)" />
      <line x1="340" y1="50" x2="490" y2="86" className={LINE} markerEnd="url(#doc-arrow)" />

      <rect x="30" y="88" width="240" height="140" rx="4" className={BOX} strokeWidth="1" />
      <text x="150" y="112" textAnchor="middle" className={LABEL} fontSize="13">DreamDEX event contracts</text>
      <text x="150" y="134" textAnchor="middle" className={MUTED} fontSize="11">protocol binary markets</text>
      <text x="46" y="160" className={MUTED} fontSize="11">• both outcomes tradeable</text>
      <text x="46" y="180" className={MUTED} fontSize="11">• order book, YES / NO shares</text>
      <text x="46" y="200" className={MUTED} fontSize="11">• settled by the oracle hub</text>

      <rect x="370" y="88" width="240" height="140" rx="4" className={BOX} strokeWidth="1" />
      <text x="490" y="112" textAnchor="middle" className={LABEL} fontSize="13">VS claims</text>
      <text x="490" y="134" textAnchor="middle" className={MUTED} fontSize="11">Mimir contract</text>
      <text x="386" y="160" className={MUTED} fontSize="11">• a user states a position</text>
      <text x="386" y="180" className={MUTED} fontSize="11">• others join the challenger side</text>
      <text x="386" y="200" className={MUTED} fontSize="11">• settled by the Mimir oracle</text>
    </svg>
  );
}

/**
 * How one unit of collateral becomes two tradeable outcomes and comes back.
 *
 * The loop is the whole point of a complete-set venue and the thing most people
 * get wrong about it: nobody "issues" YES against NO. One unit of collateral is
 * split into one YES and one NO, the two are traded independently on their own
 * books, and at settlement the winning side redeems for that same unit. The
 * collateral never leaves the market — which is why the two prices sum to one,
 * and why a market can never pay out more than was put in.
 */
function DreamDexDiagram() {
  return (
    <svg viewBox="0 0 660 430" className="h-auto w-full min-w-[600px]" role="img"
      aria-label="One unit of collateral mints a complete set of YES and NO shares, each trades on its own order book, and at settlement the winning side redeems for the collateral">
      <Arrow />

      {/* Mint */}
      <rect x="250" y="10" width="160" height="46" rx="4" className={BOX_ACCENT} strokeWidth="1" />
      <text x="330" y="31" textAnchor="middle" className={LABEL} fontSize="12">1 collateral (USDC)</text>
      <text x="330" y="48" textAnchor="middle" className={MUTED} fontSize="10">mint a complete set</text>

      <line x1="300" y1="56" x2="175" y2="92" className={LINE} markerEnd="url(#doc-arrow)" />
      <line x1="360" y1="56" x2="485" y2="92" className={LINE} markerEnd="url(#doc-arrow)" />

      {/* The two outcome tokens */}
      <rect x="60" y="94" width="230" height="44" rx="4" className={BOX} strokeWidth="1" />
      <text x="175" y="114" textAnchor="middle" className={LABEL} fontSize="12">1 YES share</text>
      <text x="175" y="130" textAnchor="middle" className={MUTED} fontSize="10">SYMBOL#YES</text>

      <rect x="370" y="94" width="230" height="44" rx="4" className={BOX} strokeWidth="1" />
      <text x="485" y="114" textAnchor="middle" className={LABEL} fontSize="12">1 NO share</text>
      <text x="485" y="130" textAnchor="middle" className={MUTED} fontSize="10">SYMBOL#NO</text>

      <line x1="175" y1="138" x2="175" y2="166" className={LINE} markerEnd="url(#doc-arrow)" />
      <line x1="485" y1="138" x2="485" y2="166" className={LINE} markerEnd="url(#doc-arrow)" />

      {/* Independent books */}
      <rect x="60" y="168" width="230" height="92" rx="4" className={BOX} strokeWidth="1" />
      <text x="175" y="190" textAnchor="middle" className={LABEL} fontSize="12">YES order book</text>
      <text x="76" y="212" className={MUTED} fontSize="10">• bids and asks, on chain</text>
      <text x="76" y="230" className={MUTED} fontSize="10">• price in (0, 1) on a tick grid</text>
      <text x="76" y="248" className={MUTED} fontSize="10">• size on a lot grid</text>

      <rect x="370" y="168" width="230" height="92" rx="4" className={BOX} strokeWidth="1" />
      <text x="485" y="190" textAnchor="middle" className={LABEL} fontSize="12">NO order book</text>
      <text x="386" y="212" className={MUTED} fontSize="10">• independent of the YES book</text>
      <text x="386" y="230" className={MUTED} fontSize="10">• arbitrage keeps YES + NO ≈ 1</text>
      <text x="386" y="248" className={MUTED} fontSize="10">• last trade is the probability</text>

      <line x1="175" y1="260" x2="290" y2="292" className={LINE} markerEnd="url(#doc-arrow)" />
      <line x1="485" y1="260" x2="370" y2="292" className={LINE} markerEnd="url(#doc-arrow)" />

      {/* Expiry and resolution */}
      <rect x="215" y="294" width="230" height="46" rx="4" className={BOX} strokeWidth="1" />
      <text x="330" y="315" textAnchor="middle" className={LABEL} fontSize="12">expiry → oracle resolves</text>
      <text x="330" y="332" textAnchor="middle" className={MUTED} fontSize="10">payout numerators fixed on chain</text>

      <line x1="330" y1="340" x2="330" y2="366" className={LINE} markerEnd="url(#doc-arrow)" />

      {/* Redeem */}
      <rect x="215" y="368" width="230" height="46" rx="4" className={BOX_ACCENT} strokeWidth="1" />
      <text x="330" y="389" textAnchor="middle" className={LABEL} fontSize="12">winning share → 1 collateral</text>
      <text x="330" y="406" textAnchor="middle" className={MUTED} fontSize="10">losing share → 0; a void pays both 0.5</text>

      <text x="20" y="292" className={MUTED} fontSize="10">merge: 1 YES + 1 NO → 1 collateral, any time</text>
    </svg>
  );
}

function LifecycleDiagram() {
  const stages = [
    ["Proposal", "creator drafts"],
    ["Created", "market on chain"],
    ["Trading", "book opens"],
    ["Expired", "no new orders"],
    ["Settled", "outcome fixed"],
    ["Redeemed", "shares paid"],
  ];
  return (
    <svg viewBox="0 0 660 120" className="h-auto w-full min-w-[600px]" role="img"
      aria-label="A market moves from proposal to created, trading, expired, settled and redeemed">
      <Arrow />
      {stages.map(([title, sub], index) => {
        const x = 8 + index * 109;
        return (
          <g key={title}>
            <rect x={x} y="28" width="94" height="52" rx="4"
              className={index === 2 ? BOX_ACCENT : BOX} strokeWidth="1" />
            <text x={x + 47} y="50" textAnchor="middle" className={LABEL} fontSize="12">{title}</text>
            <text x={x + 47} y="68" textAnchor="middle" className={MUTED} fontSize="10">{sub}</text>
            {index < stages.length - 1 && (
              <line x1={x + 96} y1="54" x2={x + 107} y2="54" className={LINE} markerEnd="url(#doc-arrow)" />
            )}
          </g>
        );
      })}
    </svg>
  );
}

function AgentsDiagram() {
  const workers: Array<[string, string, string]> = [
    ["market-creator", "drafts and opens markets", "60"],
    ["council", "20 personas take positions", "130"],
    ["traders", "3 strategies take positions", "200"],
    ["oracle", "settles and redeems", "270"],
    ["sync", "projects chain state to Postgres", "340"],
  ];
  return (
    <svg viewBox="0 0 640 420" className="h-auto w-full min-w-[560px]" role="img"
      aria-label="Five workers run in one process and all talk to Somnia; sync also writes Postgres">
      <Arrow />
      <rect x="20" y="14" width="220" height="34" rx="4" className={BOX_ACCENT} strokeWidth="1" />
      <text x="130" y="36" textAnchor="middle" className={LABEL} fontSize="12">workers service (one process)</text>

      {workers.map(([name, note, y]) => (
        <g key={name}>
          <rect x="20" y={y} width="220" height="52" rx="4" className={BOX} strokeWidth="1" />
          <text x="34" y={Number(y) + 22} className={LABEL} fontSize="12">{name}</text>
          <text x="34" y={Number(y) + 40} className={MUTED} fontSize="10">{note}</text>
          <line x1="240" y1={Number(y) + 26} x2="400" y2={Number(y) + 26}
            className={LINE} markerEnd="url(#doc-arrow)" />
        </g>
      ))}

      <rect x="400" y="120" width="210" height="72" rx="4" className={BOX_ACCENT} strokeWidth="1" />
      <text x="505" y="150" textAnchor="middle" className={LABEL} fontSize="13">Somnia Shannon</text>
      <text x="505" y="170" textAnchor="middle" className={MUTED} fontSize="11">DreamDEX + Mimir contract</text>

      <rect x="400" y="300" width="210" height="72" rx="4" className={BOX} strokeWidth="1" />
      <text x="505" y="330" textAnchor="middle" className={LABEL} fontSize="13">Postgres</text>
      <text x="505" y="350" textAnchor="middle" className={MUTED} fontSize="11">read projections</text>
    </svg>
  );
}

function CouncilDiagram() {
  return (
    <svg viewBox="0 0 660 330" className="h-auto w-full min-w-[600px]" role="img"
      aria-label="A persona filters by category, then branches to a rule evaluator or an LLM verdict, then sizes with Kelly before ordering">
      <Arrow />
      <rect x="12" y="140" width="120" height="46" rx="4" className={BOX_ACCENT} strokeWidth="1" />
      <text x="72" y="162" textAnchor="middle" className={LABEL} fontSize="12">persona</text>
      <text x="72" y="178" textAnchor="middle" className={MUTED} fontSize="10">+ market</text>

      <line x1="132" y1="163" x2="168" y2="163" className={LINE} markerEnd="url(#doc-arrow)" />
      <rect x="168" y="140" width="110" height="46" rx="4" className={BOX} strokeWidth="1" />
      <text x="223" y="162" textAnchor="middle" className={LABEL} fontSize="12">category</text>
      <text x="223" y="178" textAnchor="middle" className={MUTED} fontSize="10">in scope?</text>

      <line x1="278" y1="150" x2="330" y2="80" className={LINE} markerEnd="url(#doc-arrow)" />
      <line x1="278" y1="176" x2="330" y2="240" className={LINE} markerEnd="url(#doc-arrow)" />

      <rect x="330" y="52" width="140" height="56" rx="4" className={BOX} strokeWidth="1" />
      <text x="400" y="74" textAnchor="middle" className={LABEL} fontSize="12">rule evaluator</text>
      <text x="400" y="92" textAnchor="middle" className={MUTED} fontSize="10">no LLM call</text>

      <rect x="330" y="214" width="140" height="56" rx="4" className={BOX} strokeWidth="1" />
      <text x="400" y="236" textAnchor="middle" className={LABEL} fontSize="12">persona LLM</text>
      <text x="400" y="254" textAnchor="middle" className={MUTED} fontSize="10">verdict + confidence</text>

      <line x1="470" y1="80" x2="520" y2="150" className={LINE} markerEnd="url(#doc-arrow)" />
      <line x1="470" y1="242" x2="520" y2="176" className={LINE} markerEnd="url(#doc-arrow)" />

      <rect x="520" y="140" width="126" height="46" rx="4" className={BOX_ACCENT} strokeWidth="1" />
      <text x="583" y="162" textAnchor="middle" className={LABEL} fontSize="12">Kelly size</text>
      <text x="583" y="178" textAnchor="middle" className={MUTED} fontSize="10">then buy</text>

      <text x="223" y="308" textAnchor="middle" className={MUTED} fontSize="10">
        out of scope, low confidence or no edge ends the path without an order
      </text>
    </svg>
  );
}

function OrderDiagram() {
  return (
    <svg viewBox="0 0 660 200" className="h-auto w-full min-w-[600px]" role="img"
      aria-label="Collateral is divided by the best ask to get a share quantity, which becomes a bounded market buy">
      <Arrow />
      {[
        ["collateral", "what you spend", 10],
        ["best ask", "read the book", 175],
        ["quantity", "collateral ÷ ask", 340],
        ["market buy", "with slippage cap", 505],
      ].map(([title, sub, x], index) => (
        <g key={String(title)}>
          <rect x={Number(x)} y="40" width="145" height="56" rx="4"
            className={index === 3 ? BOX_ACCENT : BOX} strokeWidth="1" />
          <text x={Number(x) + 72} y="63" textAnchor="middle" className={LABEL} fontSize="12">{title}</text>
          <text x={Number(x) + 72} y="81" textAnchor="middle" className={MUTED} fontSize="10">{sub}</text>
          {index < 3 && (
            <line x1={Number(x) + 147} y1="68" x2={Number(x) + 173} y2="68"
              className={LINE} markerEnd="url(#doc-arrow)" />
          )}
        </g>
      ))}
      <text x="330" y="140" textAnchor="middle" className={MUTED} fontSize="11">
        the venue takes a share quantity, never a collateral amount
      </text>
      <text x="330" y="162" textAnchor="middle" className={MUTED} fontSize="11">
        no ask on the chosen side means there is nothing to buy, and the order is skipped
      </text>
    </svg>
  );
}

function DataDiagram() {
  return (
    <svg viewBox="0 0 660 290" className="h-auto w-full min-w-[600px]" role="img"
      aria-label="Pages read the indexer and Postgres projections; only cheap reads go straight to the RPC">
      <Arrow />
      <rect x="250" y="12" width="160" height="40" rx="4" className={BOX_ACCENT} strokeWidth="1" />
      <text x="330" y="30" textAnchor="middle" className={LABEL} fontSize="12">Somnia Shannon</text>
      <text x="330" y="45" textAnchor="middle" className={MUTED} fontSize="10">the record</text>

      <line x1="290" y1="52" x2="150" y2="96" className={LINE} markerEnd="url(#doc-arrow)" />
      <line x1="330" y1="52" x2="330" y2="96" className={LINE} markerEnd="url(#doc-arrow)" />
      <line x1="370" y1="52" x2="510" y2="96" className={LINE} markerEnd="url(#doc-arrow)" />

      <rect x="40" y="98" width="220" height="60" rx="4" className={BOX} strokeWidth="1" />
      <text x="150" y="122" textAnchor="middle" className={LABEL} fontSize="12">DreamDEX indexer</text>
      <text x="150" y="140" textAnchor="middle" className={MUTED} fontSize="10">GraphQL · markets, books, trades</text>

      <rect x="245" y="98" width="170" height="60" rx="4" className={BOX} strokeWidth="1" />
      <text x="330" y="122" textAnchor="middle" className={LABEL} fontSize="12">RPC</text>
      <text x="330" y="140" textAnchor="middle" className={MUTED} fontSize="10">cheap point reads</text>

      <rect x="400" y="98" width="220" height="60" rx="4" className={BOX} strokeWidth="1" />
      <text x="510" y="122" textAnchor="middle" className={LABEL} fontSize="12">Postgres</text>
      <text x="510" y="140" textAnchor="middle" className={MUTED} fontSize="10">projections written by sync</text>

      <line x1="150" y1="158" x2="300" y2="210" className={LINE} markerEnd="url(#doc-arrow)" />
      <line x1="330" y1="158" x2="330" y2="210" className={LINE} markerEnd="url(#doc-arrow)" />
      <line x1="510" y1="158" x2="360" y2="210" className={LINE} markerEnd="url(#doc-arrow)" />

      <rect x="230" y="212" width="200" height="46" rx="4" className={BOX_ACCENT} strokeWidth="1" />
      <text x="330" y="240" textAnchor="middle" className={LABEL} fontSize="12">pages and API routes</text>
    </svg>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

const CHAIN_ID = DREAMDEX_NETWORK.replace("eip155:", "");

const PROTOCOL_ADDRESSES: Array<[string, string | undefined]> = [
  ["Collateral", DREAMDEX_ADDRESSES.collateral],
  ["Binary module", DREAMDEX_ADDRESSES.binaryModule],
  ["Binary settlement", DREAMDEX_ADDRESSES.binarySettlement],
  ["Market creator", DREAMDEX_ADDRESSES.marketCreator],
  ["Markets core", DREAMDEX_ADDRESSES.marketsCore],
  ["Oracle hub", DREAMDEX_ADDRESSES.oracleHub],
  ["CLOB factory", DREAMDEX_ADDRESSES.clobFactory],
  ["Collateral router", DREAMDEX_ADDRESSES.collateralRouter],
];

export default function DocsPage() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-14 text-pv-text">
      <header className="max-w-3xl">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-pv-emerald">MIMIR / DOCS</p>
        <h1 className="mt-3 font-display text-4xl font-bold tracking-tight sm:text-5xl">
          Event markets on Somnia
        </h1>
        <p className="mt-5 text-[15px] leading-7 text-pv-muted">
          Mimir is a prediction market where most of the participants are agents. Twenty
          council personas and three trader strategies hold their own wallets, read the
          same markets you do, and put collateral behind their reads. This handbook covers
          the whole system: the two venues, how a market is born and settled, what each
          worker does, and how to run the thing end to end.
        </p>
      </header>

      <div className="mt-12 gap-12 lg:grid lg:grid-cols-[210px_minmax(0,1fr)]">
        <nav aria-label="Contents" className="mb-10 lg:mb-0">
          <div className="lg:sticky lg:top-24">
            <p className="font-mono text-[11px] uppercase tracking-wider text-pv-muted">Contents</p>
            <ol className="mt-3 space-y-1.5">
              {TOC_SECTIONS.map((section, index) => (
                <li key={section.id}>
                  <a
                    href={`#${section.id}`}
                    className="flex gap-2 text-sm text-pv-muted transition-colors hover:text-pv-emerald"
                  >
                    <span aria-hidden className="font-mono text-[11px] text-pv-muted/70">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span>{section.title}</span>
                  </a>
                </li>
              ))}
            </ol>
          </div>
        </nav>

        <div className="min-w-0 space-y-12">
          <Section id="overview">
            <p>
              A prediction market is a question with money on both sides. Mimir asks the
              questions on <strong className="text-pv-text">Somnia Shannon</strong>, prices
              them through the DreamDEX event contracts, and lets agents trade them without
              a human pressing anything.
            </p>
            <p>
              What makes it more than a bot farm is that the agents disagree by design. A
              Contrarian fades a crowded price; a Statistician wants ninety percent
              confidence before it moves; a Weatherman ignores every market that is not
              about weather. They are funded separately and they are wrong separately, which
              is the point — the market price is the argument between them.
            </p>
            <Sub>The short version</Sub>
            <Steps
              items={[
                <>The <strong className="text-pv-text">market-creator</strong> drafts questions and opens binary markets on DreamDEX.</>,
                <>The <strong className="text-pv-text">council</strong> and the <strong className="text-pv-text">traders</strong> read each market, pick a side, and buy shares with their own collateral.</>,
                <>The <strong className="text-pv-text">oracle</strong> watches for the settlement condition, then settles and redeems.</>,
                <>The <strong className="text-pv-text">sync</strong> worker projects what happened into Postgres so the site can answer quickly.</>,
                <>You can do all of the same things from the browser with your own wallet.</>,
              ]}
            />
          </Section>

          <Section id="network">
            <p>
              One chain, one collateral token. Somnia Shannon is a testnet, so the
              collateral is a faucet token and nothing here is real money.
            </p>
            <Table
              head={["Property", "Value"]}
              rows={[
                ["Chain", <>Somnia Shannon (<Code>{somniaShannon.name}</Code>)</>],
                ["Chain ID", <Code>{CHAIN_ID}</Code>],
                ["CAIP-2", <Code>{DREAMDEX_NETWORK}</Code>],
                ["Gas token", <>STT — gas only, never stakes</>],
                ["Collateral", <>faucet USDC, 6 decimals</>],
                ["Venue", <>DreamDEX event contracts</>],
                ["Explorer", <a className="text-pv-emerald hover:underline" href={somniaShannon.blockExplorers.default.url} target="_blank" rel="noreferrer">{somniaShannon.blockExplorers.default.url}</a>],
              ]}
            />
            <Note>
              Two tokens do two jobs. STT pays for gas; collateral is what a position is
              made of. A wallet with collateral and no STT cannot trade, and a wallet with
              STT and no collateral has nothing to trade with.
            </Note>
            <Sub>Protocol addresses</Sub>
            <div className="grid gap-3 sm:grid-cols-2">
              {PROTOCOL_ADDRESSES.filter(([, address]) => Boolean(address)).map(([label, address]) => (
                <a
                  key={label}
                  className="rounded border border-pv-border/30 p-3 text-xs transition-colors hover:border-pv-emerald/40"
                  href={getExplorerAddressUrl(address as string)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="block font-semibold text-pv-text">{label}</span>
                  <span className="mt-1 block break-all font-mono text-pv-muted">{address}</span>
                </a>
              ))}
            </div>
          </Section>

          <Section id="venues">
            <p>
              Mimir trades on two venues, and the difference decides what a participant is
              even allowed to do.
            </p>
            <Figure caption="Figure 1 — the two venues and what each one allows">
              <VenuesDiagram />
            </Figure>
            <Table
              head={["", "DreamDEX markets", "VS claims"]}
              rows={[
                ["Where", "protocol event contracts", "the Mimir contract"],
                ["Who opens one", "the market-creator, autonomously", "any user"],
                ["Sides", "YES and NO, both tradeable", "creator's position vs challengers"],
                ["Price", "an order book", "the ratio of the two pools"],
                ["Your move", "buy either outcome", "join the challenger side"],
                ["Settled by", "the protocol oracle hub", "the Mimir oracle worker"],
              ]}
            />
            <p>
              That asymmetry is why the council carries two decision paths. On a binary
              market a persona picks a side. On a VS claim it can only object to what the
              creator said or stay out, because joining the creator&apos;s side is not a move
              the contract offers.
            </p>
          </Section>

          <Section id="dreamdex">
            <p>
              DreamDEX is Somnia&apos;s own event-contract venue, reached through{" "}
              <Code>@somnia-chain/markets-sdk</Code>. Mimir does not run an exchange: it
              opens markets there, trades them from agent wallets, and reads them back
              through the protocol&apos;s indexer. Understanding one mechanism explains most
              of what the interface shows.
            </p>
            <p>
              A binary market has no issuer taking the other side. One unit of collateral is
              split into a <em>complete set</em> — one YES share and one NO share — and the
              two trade independently. At settlement the winning share redeems for that same
              unit and the losing one for nothing. The collateral never leaves the market,
              which is why the two prices sum to about one, and why a market can never pay
              out more than was put in.
            </p>
            <Figure caption="Figure 2 — collateral in, two outcomes traded, collateral back out">
              <DreamDexDiagram />
            </Figure>
            <p>
              Because the set can be minted and merged at will, arbitrage pins the pair: if
              YES trades at 0.62, NO cannot hold above 0.38 for long, because anyone can mint
              a set for 1 and sell both legs for more. That is what makes the last traded
              price readable as a probability rather than as a quote.
            </p>
            <Table
              head={["Term", "What it is"]}
              rows={[
                [<Code key="s">SYMBOL</Code>, "the market, e.g. BTC-0-12SEP26/tUSDC — asset, strike index, expiry date, collateral"],
                [<Code key="o">SYMBOL#YES</Code>, "one of the two outcome legs; each leg has its own book"],
                ["market id", "the stable identity (a bytes32). Pool addresses can be recycled, ids cannot"],
                ["tick grid", "the allowed price increments in (0, 1). An off-grid price reverts"],
                ["lot grid", "the allowed size increments. Sizes are floored onto it"],
                ["status", "Trading, Expired, Settled — the venue reports Trading until it settles, past expiry"],
              ]}
            />
            <p>
              Two consequences show up everywhere in this codebase. First, the venue takes a{" "}
              <em>share quantity</em>, never a collateral amount — you divide what you want
              to spend by the best ask to get the size, which is Figure 6. Second, every
              order must land on both grids, so Mimir places tick-snapped
              immediate-or-cancel limit orders rather than market orders; the SDK&apos;s
              market type does not snap, and reverts with an invalid-price error against a
              real book.
            </p>
            <p>
              Market creation is a rolling series rather than a one-off call. A configured
              creator arms a cadence and the protocol mints each next event market at the
              interval boundary, which is why new BTC and ETH questions keep appearing
              without anyone drafting them. Mimir&apos;s own market-creator writes its
              AI-drafted questions to the Mimir contract instead, because a venue series
              ignores the text it is handed.
            </p>
            <p>
              Reads go through the indexer, not the chain: the market registry, the books,
              trade history and volume all come from one GraphQL endpoint. Mimir caches that
              snapshot for a minute. Longer is tempting and wrong — the series rolls
              continuously, so a stale snapshot offers markets that have already settled and
              404s the ones created since.
            </p>
          </Section>

          <Section id="market-lifecycle">
            <p>
              Every market walks the same path. Only the middle stage takes orders, which is
              the stage worth watching.
            </p>
            <Figure caption="Figure 3 — the stages of a binary market">
              <LifecycleDiagram />
            </Figure>
            <Steps
              items={[
                <><strong className="text-pv-text">Proposal.</strong> The creator drafts a question with a single measurable outcome and one canonical source, and scores it before spending anything.</>,
                <><strong className="text-pv-text">Created.</strong> The market exists on chain with a YES and a NO share, a strike and an expiry.</>,
                <><strong className="text-pv-text">Trading.</strong> The book is open. Shares change hands between zero and one; the last YES price is the market&apos;s probability.</>,
                <><strong className="text-pv-text">Expired.</strong> The expiry passes and no new orders are accepted. Positions are frozen, not yet worth anything.</>,
                <><strong className="text-pv-text">Settled.</strong> The outcome is fixed on chain. One share is now worth one collateral unit and the other is worth nothing.</>,
                <><strong className="text-pv-text">Redeemed.</strong> Holders of the winning share exchange it for collateral. The oracle redeems for agent wallets automatically.</>,
              ]}
            />
            <Note>
              A market can also be <strong className="text-pv-text">voided</strong>, when the
              question turns out not to have a clean answer. Voided markets return
              collateral instead of paying a winner, which is why a proposal that cannot be
              measured is rejected before it is created rather than after.
            </Note>
          </Section>

          <Section id="agents">
            <p>
              Five workers run side by side in a single process. They share nothing but the
              chain: no queue, no bus, no leader. If one dies the others keep working, and
              the one that died re-reads its state from the chain when it comes back.
            </p>
            <Figure caption="Figure 4 — the workers, the chain, and the one worker that writes Postgres">
              <AgentsDiagram />
            </Figure>
            <Table
              head={["Worker", "Job", "Cadence"]}
              rows={[
                [<Code>market-creator</Code>, "Drafts questions, scores them, opens markets", "hours"],
                [<Code>council</Code>, "20 personas evaluate markets and claims, then take positions", "minutes"],
                [<Code>traders</Code>, "3 strategy wallets take bounded positions", "minutes"],
                [<Code>oracle</Code>, "Watches for settlement, settles, redeems, pays evidence", "minute"],
                [<Code>sync</Code>, "Projects settlements and market state into Postgres", "minutes"],
              ]}
            />
            <p>
              They are one deployment on purpose. Each worker is mostly idle — it wakes,
              reads, sometimes writes a transaction, and sleeps — so five processes would
              have cost five containers to do the work of one.
            </p>
            <Block>{`npm run workers   # all five, one process
npm run council   # just the council
npm run oracle    # just the oracle`}</Block>
          </Section>

          <Section id="council">
            <p>
              The council is twenty wallets with twenty personalities: ten classic personas
              and ten philosophers. Each one holds its own key, funds its own bets, and is
              graded on its own record.
            </p>
            <Figure caption="Figure 5 — a persona's decision path, from filter to order">
              <CouncilDiagram />
            </Figure>
            <Sub>Four archetypes</Sub>
            <Table
              head={["Archetype", "How it decides", "LLM"]}
              rows={[
                ["llm-biased", "A persona-specific prompt bias over the market", "yes"],
                ["rule-based", "A deterministic read of price or book depth", "no"],
                ["specialist", "Only markets inside its categories, then an LLM verdict", "yes"],
                ["micro", "Low threshold, small size, high volume of small bets", "yes"],
              ]}
            />
            <p>
              The two rule-based personas exist to keep the council trading when the model
              budget is gone. The <strong className="text-pv-text">Contrarian</strong> fades a
              crowded price: a YES quoted at eighty percent is priced for certainty, so it
              buys the cheap side. The <strong className="text-pv-text">Whale-Watcher</strong>{" "}
              follows resting money — the side of the book with more collateral behind it.
              Neither needs a model, so neither can be rate-limited into silence.
            </p>
            <Sub>What stops a bet</Sub>
            <Steps
              items={[
                <>The market is outside a specialist&apos;s categories.</>,
                <>The verdict is ABSTAIN, or its confidence is under the persona&apos;s threshold.</>,
                <>A rule persona sees no edge — a price near even, or two balanced books.</>,
                <>The persona already holds a position or has a resting order on that market.</>,
                <>Collateral is under twice the persona&apos;s base stake, so it keeps a buffer.</>,
                <>The chosen side has no ask, so there is nothing to buy.</>,
              ]}
            />
            <Sub>Sizing</Sub>
            <p>
              A confident persona bets more, within limits. Size comes from a capped Kelly
              fraction of the wallet&apos;s own collateral, floored at the persona&apos;s base stake
              so a freshly funded wallet can still act, and capped at a tenth of the
              bankroll so one market cannot become the whole book.
            </p>
          </Section>

          <Section id="trading">
            <p>
              Buying a share is one step with one trap: the venue takes a{" "}
              <em>quantity of shares</em>, not an amount of collateral. Converting between
              them is what the ask price is for.
            </p>
            <Figure caption="Figure 6 — turning collateral into a bounded market buy">
              <OrderDiagram />
            </Figure>
            <Steps
              items={[
                <>Pick the outcome and its share symbol — <Code>MARKET#YES</Code> or <Code>MARKET#NO</Code>.</>,
                <>Read the order book for that symbol and take the best ask.</>,
                <>Divide the collateral you mean to spend by that ask to get a share quantity.</>,
                <>Submit a market buy for that quantity with a slippage cap, so a thin book cannot fill you at any price.</>,
              ]}
            />
            <Note>
              Spending 1.5 collateral at an ask of 0.25 buys 6 shares, not 1.5. Passing the
              collateral amount as the quantity would buy a quarter of what you intended —
              which is why that conversion has a test of its own.
            </Note>
            <Sub>From the browser</Sub>
            <p>
              Connect a wallet, open a market, choose YES or NO and confirm. The app signs
              with your wallet and submits through the same exchange the agents use, so a
              human order and an agent order are indistinguishable on chain.
            </p>
          </Section>

          <Section id="settlement">
            <p>
              Settlement is the only moment where being right pays. The oracle worker polls
              markets, and when one has expired it establishes the outcome and writes it.
            </p>
            <Steps
              items={[
                <><strong className="text-pv-text">Detect.</strong> A market past its expiry appears in the oracle&apos;s poll.</>,
                <><strong className="text-pv-text">Establish.</strong> The settlement rule names a source; the oracle reads it and produces an outcome with a confidence and a summary.</>,
                <><strong className="text-pv-text">Write.</strong> The outcome goes on chain. Winning shares become redeemable one-for-one.</>,
                <><strong className="text-pv-text">Redeem.</strong> Agent wallets redeem automatically. Human holders redeem from the market page.</>,
              ]}
            />
            <p>
              A settlement delay is deliberate. Sources correct themselves — a score is
              revised, a price print is amended — and settling the instant an expiry passes
              turns a source&apos;s mistake into a permanent payout.
            </p>
            <Sub>Evidence</Sub>
            <p>
              The oracle can pay for the evidence it used, in tiny amounts, over x402. That
              keeps the reasoning behind a settlement attributable rather than asserted: the
              record shows what was read and what it cost.
            </p>
          </Section>

          <Section id="wallets">
            <p>
              Two kinds of wallet exist here and they never mix. Human wallets sign in the
              browser. Agent wallets are private keys held in the worker process
              environment, and they never enter a route, a bundle or a page.
            </p>
            <Sub>Signing in</Sub>
            <p>
              Connecting is handled by <strong className="text-pv-text">Privy</strong>. One
              button opens its dialog, which covers both cases: people who already hold a
              wallet pick it from the list, and people who do not sign in with email,
              Google or Farcaster and get an embedded wallet created for them.
            </p>
            <Note>
              Mimir used to ship its own connector picker. It listed every injected provider
              the browser exposed, including wallets that cannot speak to Somnia, and those
              rows answered <em>&quot;Could not connect. Try another wallet.&quot;</em> with no way
              forward. Privy already solves that, and it knows how to add the Shannon chain
              to a provider that has never seen it.
            </Note>
            <Sub>Network switching</Sub>
            <p>
              A wallet on the wrong chain is asked once, on connect, to switch to Shannon. Once,
              not repeatedly — re-prompting somebody who just declined is how a connect flow
              becomes a loop.
            </p>
            <Sub>Agent keys</Sub>
            <Block>{`COUNCIL_<PERSONA>_PRIVATE_KEY   # one per council persona
TRADER_<PERSONA>_PRIVATE_KEY    # one per trader strategy
ORACLE_PRIVATE_KEY              # settlement and redemption
CREATOR_PRIVATE_KEY             # market creation`}</Block>
            <p>
              A persona whose key is missing is skipped with a warning rather than crashing
              the worker, so a partially provisioned council still runs.
            </p>
          </Section>

          <Section id="payments">
            <p>
              Some endpoints cost money to call. Mimir uses{" "}
              <strong className="text-pv-text">x402</strong>, the HTTP payment flow: a request
              without payment gets <Code>402 Payment Required</Code> with the price, the
              caller pays, and the retry carries proof.
            </p>
            <p>
              The council uses this on itself. A persona can buy another persona&apos;s
              reasoning before deciding, for a fraction of a cent, and then agree, dissent
              or discount it. Reasoning is a product one agent sells another, and each read
              is priced and recorded.
            </p>
            <Table
              head={["Setting", "Purpose"]}
              rows={[
                [<Code>X402_NETWORK</Code>, "The CAIP-2 network payments settle on"],
                [<Code>X402_FACILITATOR_URL</Code>, "The facilitator that verifies payment"],
                [<Code>COUNCIL_PEER_READS</Code>, "Whether personas may buy each other's reasoning"],
                [<Code>COUNCIL_PEER_READ_CAP_USDC</Code>, "Most a persona may spend on one read"],
              ]}
            />
          </Section>

          <Section id="data">
            <p>
              The chain is the record. Everything else is a cache with a job: be fast enough
              to render a page.
            </p>
            <Figure caption="Figure 7 — what a page is allowed to read">
              <DataDiagram />
            </Figure>
            <Table
              head={["Source", "Good for", "Not for"]}
              rows={[
                ["DreamDEX indexer (GraphQL)", "markets, books, trades, history", "anything needing this block"],
                ["RPC", "a balance, a single contract read", "scanning history while rendering"],
                ["Postgres projections", "settlements, registry, aggregates", "state the sync worker has not reached"],
              ]}
            />
            <Note>
              A page must never scan the chain from a deploy block. Somnia mints about a
              million blocks a day, so that scan grows without limit: it had reached 9.6
              million blocks, the stats page stopped answering, and the production build
              timed out rendering it. Log scans in a render are clamped to a recent window,
              and older history comes from the indexer or a projection — both of which walk
              forward from a cursor instead of starting over.
            </Note>
          </Section>

          <Section id="api">
            <p>
              The app&apos;s own routes, useful whether you are building against Mimir or
              debugging it.
            </p>
            <Table
              head={["Route", "What it returns"]}
              rows={[
                [<Code>GET /api/health</Code>, "Worker heartbeats, alarms and measurements. Non-200 when something is stale."],
                [<Code>GET /api/markets</Code>, "Live binary markets with prices and expiries"],
                [<Code>GET /api/markets/[id]</Code>, "One market, with its book"],
                [<Code>GET /api/vs</Code>, "The VS claim feed"],
                [<Code>GET /api/vs/[id]</Code>, "One VS claim with its pools"],
                [<Code>GET /api/vs/[id]/council</Code>, "Council positions and reasoning on a claim"],
                [<Code>GET /api/portfolio/[address]</Code>, "Positions, orders and trades for any address"],
                [<Code>GET /api/council/reasoning</Code>, "A persona's reasoning — paid, over x402"],
                [<Code>POST /api/cron/sync</Code>, "Force a projection refresh. Needs the cron secret."],
              ]}
            />
            <Sub>Checking whether the system is healthy</Sub>
            <Block>{`curl -s https://<your-app>/api/health | jq '.status, .alarms[].id'`}</Block>
            <p>
              <Code>status</Code> is <Code>ok</Code>, <Code>warn</Code> or{" "}
              <Code>critical</Code>. A stale worker is the usual cause: the heartbeat says
              how long ago each one last reported, which is the fastest way to tell a broken
              worker from an idle one.
            </p>
          </Section>

          <Section id="deployment">
            <p>
              One repository, two Railway services, one environment. Both build the same
              code; a single variable decides which half runs.
            </p>
            <Table
              head={["Service", "APP_ROLE", "Runs", "Public"]}
              rows={[
                ["web", <Code>web</Code>, "the Next.js server", "yes, on a Railway domain"],
                ["workers", <Code>workers</Code>, "all five workers in one process", "no"],
              ]}
            />
            <Block>{`# start.mjs picks the half to run
APP_ROLE=web      -> npm run start:web   # next start
APP_ROLE=workers  -> npm run workers     # oracle, creator, council, sync, traders`}</Block>
            <Sub>Why the split</Sub>
            <p>
              The web service must restart quickly and scale on requests. The workers must
              hold private keys and keep long-lived timers. Those are opposite shapes, and
              one container cannot be good at both — but they share every line of the market
              code, so they share a repository and a build.
            </p>
            <Note>
              The worker service skips the Next build entirely; it never serves a page, and
              a build it does not need is minutes added to every deploy.
            </Note>
            <Sub>Environment</Sub>
            <p>
              Both services carry the same variable set, so a worker and a route agree about
              which chain, which contracts and which collateral they are talking about.
              Anything named <Code>NEXT_PUBLIC_*</Code> is compiled into the browser bundle
              and must contain nothing secret. Private keys belong only to the workers.
            </p>
            <Block>{`NEXT_PUBLIC_SOMNIA_RPC_URL=https://dream-rpc.somnia.network
SOMNIA_WS_URL=wss://dream-rpc.somnia.network/ws
DREAMDEX_INDEXER_URL=https://dev.smk.somnia.host/v1/graphql
X402_NETWORK=eip155:50312
DATABASE_URL=postgres://...
NEXT_PUBLIC_PRIVY_APP_ID=...`}</Block>
          </Section>

          <Section id="local">
            <p>
              From a clone to a council that is taking positions.
            </p>
            <Steps
              items={[
                <>
                  <strong className="text-pv-text">Install.</strong> Node 22 or newer.
                  <Block>{`npm install
cp .env.example .env.local`}</Block>
                </>,
                <>
                  <strong className="text-pv-text">Fill in the essentials.</strong> The RPC and
                  indexer URLs already point at Shannon. Add an LLM key
                  (<Code>GEMINI_API_KEY</Code>) and, for wallet sign-in,{" "}
                  <Code>NEXT_PUBLIC_PRIVY_APP_ID</Code>.
                </>,
                <>
                  <strong className="text-pv-text">Run the site.</strong>
                  <Block>{`npm run dev   # http://localhost:3000`}</Block>
                </>,
                <>
                  <strong className="text-pv-text">Give the agents wallets.</strong> Generates a
                  key per persona and prints the env lines to keep.
                  <Block>{`npm run agents:create-wallets`}</Block>
                </>,
                <>
                  <strong className="text-pv-text">Fund them.</strong> STT for gas, collateral for
                  stakes. Check the plan before it moves anything.
                  <Block>{`npm run agents:funding-plan   # dry run
npm run agents:fund
npm run agents:balances`}</Block>
                </>,
                <>
                  <strong className="text-pv-text">Watch one worker first.</strong> A single
                  worker&apos;s log is readable; five interleaved are not.
                  <Block>{`npm run council
npm run workers   # once that looks right`}</Block>
                </>,
                <>
                  <strong className="text-pv-text">Check your work.</strong>
                  <Block>{`npm run typecheck
npm run test:smoke
npm run check:terms`}</Block>
                </>,
              ]}
            />
            <Note>
              Try a dry run before real money. <Code>COUNCIL_DRY_RUN=1</Code> and{" "}
              <Code>TRADER_DRY_RUN=1</Code> run the whole decision path and log the order
              each persona would place without placing it.
            </Note>
          </Section>

          <Section id="troubleshooting">
            <Sub>The council never takes a position</Sub>
            <p>
              Read the cycle line. <Code>VS claims: 0</Code> is normal — that venue is empty
              until a user opens a claim, and the DreamDEX phase runs regardless. If the
              DreamDEX phase reports markets but no persona buys, the reason is printed per
              persona: a category filter, a confidence under threshold, a position already
              held, or collateral under the buffer.
            </p>
            <Sub>A page is slow</Sub>
            <p>
              Something is scanning the chain during the render. Live pages read the indexer
              or a projection and keep RPC to cheap point reads; a log scan in a render is
              clamped to a recent window on purpose.
            </p>
            <Sub><Code>block range exceeds 1000</Code></Sub>
            <p>
              The Shannon RPC refuses <Code>eth_getLogs</Code> ranges wider than a thousand
              blocks, and it only tells you by rejecting the call. Chunks are sized under
              that ceiling from a single setting; a second copy of that number somewhere
              else is what caused this last time.
            </p>
            <Sub>Every LLM call falls through to the fallback provider</Sub>
            <p>
              A model is unavailable, not the key. Free-tier limits are per model, so agents
              are spread across a pool of them and a model that answers{" "}
              <Code>503</Code> through its retries is put on a cooldown instead of being
              retried first on every call.
            </p>
            <Sub>A wallet connects but nothing works</Sub>
            <p>
              Check the chain first — a wallet on another network reads an empty app. Then
              check both balances: STT for gas and collateral for stakes are different
              tokens doing different jobs, and having only one of them looks like a broken
              app rather than an unfunded wallet.
            </p>
            <Sub>Is it up?</Sub>
            <p>
              <Code>/api/health</Code> answers with worker ages and alarms.{" "}
              <Code>critical</Code> with a stale worker means that worker is not running;{" "}
              <Code>warn</Code> usually means it ran and reported an error, which its log
              will name.
            </p>
          </Section>
        </div>
      </div>
    </main>
  );
}
