import { CircleCheck, CircleDot, Info, ShieldAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import { Badge, type Tone } from "./badge";

const defaultIcon: Record<Tone, LucideIcon> = {
  neutral: CircleDot,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: ShieldAlert,
  info: Info,
};

/** Status = color + text + icon (M10 §15). */
export function StatusBadge({ tone, label, icon }: { tone: Tone; label: string; icon?: LucideIcon }) {
  const Icon = icon ?? defaultIcon[tone];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" className="h-3.5 w-3.5" />
      {label}
    </Badge>
  );
}
