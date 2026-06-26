import { forwardRef } from "react";
import type { LucideProps } from "lucide-react";

/** Иконка пилы (в lucide нет Saw) — стиль как у lucide. */
export const Saw = forwardRef<SVGSVGElement, LucideProps>(
  ({ size = 24, strokeWidth = 2, ...props }, ref) => (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M4 18 18 8" />
      <path d="M18 8 16 20 10 17 4 18z" />
      <path d="M7 16.5 9 14.5M10 15 12 13M13 13.5 15 11.5" />
    </svg>
  ),
);
Saw.displayName = "Saw";
