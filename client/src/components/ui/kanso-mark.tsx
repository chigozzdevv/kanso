import type { SVGProps } from 'react';

export function KansoMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path d="M7 0h5.4c1.55 0 2.8 1.25 2.8 2.8v8.7c0 1.9-.92 3.5-2.7 4.5l-11 6C.6 22.5 0 22 0 20.8V7a7 7 0 0 1 7-7Z" />
      <path d="M25 0h-5.4a2.8 2.8 0 0 0-2.8 2.8v8.7c0 1.9.92 3.5 2.7 4.5l11 6c.9.5 1.5 0 1.5-1.2V7a7 7 0 0 0-7-7Z" />
      <path d="M14.3 17.6a3.5 3.5 0 0 1 3.4 0l12.2 6.7c2.1 1.15 2.35 2.7 1.2 4.6C29.8 31 27.7 32 25 32H7c-2.7 0-4.8-1-6.1-3.1-1.15-1.9-.9-3.45 1.2-4.6l12.2-6.7Z" />
    </svg>
  );
}
