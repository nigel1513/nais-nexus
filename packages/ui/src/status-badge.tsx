import { CircleCheck, CircleDot, Info, ShieldAlert, TriangleAlert, type LucideIcon } from "lucide-react";
import { Badge, type Tone } from "./badge";
import { iconStroke } from "./styles";

const defaultIcon: Record<Tone, LucideIcon> = {
  neutral: CircleDot,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: ShieldAlert,
  info: Info,
  accent: CircleDot,
};

/** Status = color + text + icon, never color alone (M10 §15). */
export function StatusBadge({ tone, label, icon }: { tone: Tone; label: string; icon?: LucideIcon }) {
  const Icon = icon ?? defaultIcon[tone];
  return (
    <Badge tone={tone}>
      <Icon aria-hidden="true" strokeWidth={iconStroke} />
      {label}
    </Badge>
  );
}
