import { Button } from "@/components/ui/button";
import { Minus, Plus } from "lucide-react";

interface StepperProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  label?: string;
}

export function Stepper({ value, onChange, min = 0, max, label }: StepperProps) {
  const dec = () => onChange(Math.max(min, value - 1));
  const inc = () => onChange(max !== undefined ? Math.min(max, value + 1) : value + 1);
  return (
    <div className="space-y-1">
      {label && <label className="text-[13px] font-medium">{label}</label>}
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-[26px] w-[28px] rounded-[6px]"
          onClick={dec}
          disabled={value <= min}
          aria-label={`Decrease ${label ?? "value"}`}
        >
          <Minus className="h-3 w-3" />
        </Button>
        <div className="h-9 flex-1 min-w-[48px] rounded-[6px] border border-border flex items-center justify-center text-sm tabular-nums">
          {value}
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-[26px] w-[28px] rounded-[6px]"
          onClick={inc}
          disabled={max !== undefined && value >= max}
          aria-label={`Increase ${label ?? "value"}`}
        >
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
