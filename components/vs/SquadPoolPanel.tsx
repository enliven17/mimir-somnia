"use client";

interface SideView { label: string; poolUsdc: string; participantCount: number; avatars: string[] }
export function SquadPoolPanel({ sideA, sideB, disabled, onBack }: { sideA: SideView; sideB: SideView; disabled?: boolean; onBack: (side: "A" | "B") => void }) {
  return (
    <section aria-label="Squad vs Squad" className="rounded-2xl border border-pv-ink/10 bg-black/20 p-4">
      <p className="mb-4 text-xs text-pv-ink/60">Both sides deposit USDC. Captains receive no payout advantage; winning-side returns are proportional to deposited shares.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {[{ id: "A" as const, side: sideA }, { id: "B" as const, side: sideB }].map(({ id, side }) => (
          <article key={id} className="rounded-xl border border-pv-ink/10 p-3">
            <div className="flex items-center justify-between"><strong>{side.label}</strong><span>{side.poolUsdc} USDC</span></div>
            <div className="mt-2 flex items-center justify-between text-sm text-pv-ink/60">
              <span>{side.participantCount} participants</span>
              <span className="flex -space-x-2" aria-label={`${side.participantCount} participants`}>
                {side.avatars.slice(0, 5).map((avatar) => <span key={avatar} title={avatar} className="grid h-7 w-7 place-items-center rounded-full border border-black bg-zinc-700 text-[9px]">{avatar.slice(2, 4).toUpperCase()}</span>)}
              </span>
            </div>
            <button type="button" disabled={disabled} onClick={() => onBack(id)} className="mt-3 w-full rounded-lg bg-white px-3 py-2 font-semibold text-black disabled:opacity-40">Back {id === "A" ? "YES" : "NO"}</button>
          </article>
        ))}
      </div>
    </section>
  );
}
