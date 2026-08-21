import { openPeepsAvatar } from "@/lib/avatars";

/**
 * An agent's face.
 *
 * Seeded by id and address together so a face is stable for an agent but never
 * shared with another: two agents that happen to share a display name still look
 * different, which is the whole point of showing a face instead of a letter.
 *
 * Transparent background so the tile below shows through and the avatar reads on
 * either palette — the default DiceBear background is a fixed dark navy.
 */
export function AgentAvatar({
  id, address, name, size = 32, className = "",
}: {
  id: string;
  address: string;
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`grid shrink-0 place-items-center overflow-hidden rounded-full border border-pv-ink/[0.14] bg-pv-surface2/70 ${className}`}
      style={{ width: size, height: size }}
    >
      {/* Remote SVG, so next/image would only add a loader in front of a 2 KB file. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={openPeepsAvatar(`mimir-agent-${id}-${address.slice(2, 10)}`, null)}
        alt={`${name} avatar`}
        width={size}
        height={size}
        loading="lazy"
        className="h-full w-full object-cover object-top"
      />
    </span>
  );
}

/**
 * A basket's members at a glance.
 *
 * Overlapped rather than spaced: the row is an identity, not a list to read, and
 * overlapping keeps a ten-member basket the width of a heading.
 */
export function AgentAvatarStack({
  agents, size = 28, max = 6,
}: {
  agents: Array<{ id: string; address: string; displayName: string }>;
  size?: number;
  max?: number;
}) {
  const shown = agents.slice(0, max);
  const overflow = agents.length - shown.length;
  return (
    <span className="flex items-center">
      {shown.map((agent, index) => (
        <span
          key={agent.id}
          className="relative"
          style={{ marginLeft: index === 0 ? 0 : -size / 3, zIndex: shown.length - index }}
          title={agent.displayName}
        >
          <AgentAvatar
            id={agent.id}
            address={agent.address}
            name={agent.displayName}
            size={size}
            className="ring-2 ring-pv-bg"
          />
        </span>
      ))}
      {overflow > 0 && (
        <span
          className="relative grid place-items-center rounded-full border border-pv-ink/[0.14] bg-pv-surface2 font-mono text-[10px] text-pv-muted ring-2 ring-pv-bg"
          style={{ width: size, height: size, marginLeft: -size / 3 }}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}
