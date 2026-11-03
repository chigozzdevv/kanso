'use client';

import { useState } from 'react';
import type { ComponentProps } from 'react';
import styles from '@/components/ui/select.module.css';

export function Select({
  className,
  onPointerDown,
  onKeyDown,
  onBlur,
  ...props
}: ComponentProps<'select'>) {
  const [pointerFocus, setPointerFocus] = useState(false);
  return (
    <select
      {...props}
      className={`${styles.control} ${className ?? ''}`}
      data-pointer-focus={pointerFocus || undefined}
      onPointerDown={(event) => {
        setPointerFocus(true);
        onPointerDown?.(event);
      }}
      onKeyDown={(event) => {
        if (!['Escape', 'Enter'].includes(event.key)) setPointerFocus(false);
        onKeyDown?.(event);
      }}
      onBlur={(event) => {
        setPointerFocus(false);
        onBlur?.(event);
      }}
    />
  );
}
