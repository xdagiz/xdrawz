export const formatRelativeTime = (timestamp: number) => {
  const diff = Date.now() - timestamp;
  if (diff <= 0) return "just now";

  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";

  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;

  return `${minutes}m ago`;
};
