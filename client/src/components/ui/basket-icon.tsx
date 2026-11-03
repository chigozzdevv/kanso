import type { SVGProps } from 'react';

export function BasketIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M10 12V9a6 6 0 0 1 12 0v3" />
      <path d="M4.5 12.5h23l-3 13a2 2 0 0 1-1.95 1.5H9.45a2 2 0 0 1-1.95-1.5z" />
      <path d="M3 12.5h26M12 17l1 6m7-6-1 6" />
    </svg>
  );
}
